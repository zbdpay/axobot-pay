import {
  decodePaymentCredential,
  encodePaymentRequest,
  type LightningChargeCredentialPayload,
} from "@axobot/mppx";
import crypto from "node:crypto";
import { resolvePaymentConfig } from "./config.js";
import {
  AgentPayError,
  createAmountMismatchError,
  createInvalidCredentialError,
  createInvalidPaymentProofError,
  createInvoiceCreationFailedError,
  createPaymentRequiredError,
  createPricingError,
  createResourceMismatchError,
  createTokenExpiredError,
} from "./errors.js";
import {
  createMacaroon,
  createPaymentHash,
  parseAuthorizationHeader,
  verifyMacaroon,
} from "./l402.js";
import type { PaymentConfig, ResolvedPaymentConfig } from "./types.js";
import {
  createX402Charge,
  getBtcUsdRate,
  satsToUsdcAmount,
  verifyX402Payment,
  type X402PaymentRequirement,
} from "./x402.js";
import { createCharge, getCharge } from "./zbd.js";

export interface PaymentMiddlewareFoundation<RequestLike = unknown> {
  readonly config: ResolvedPaymentConfig<RequestLike>;
  evaluateRequest(
    request: RequestLike,
    context: {
      authorizationHeader: string | undefined;
      resourcePath: string;
    },
  ): Promise<PaymentDecision>;
}

export interface PaymentChallengeBody {
  error: {
    code: "payment_required";
    message: string;
  };
  macaroon: string;
  invoice: string;
  paymentHash: string;
  amountSats: number;
  expiresAt: number;
}

export interface X402ChallengeBody {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  resource: string;
}

export interface MppChallengeBody {
  error: {
    code: "payment_required";
    message: string;
  };
  paymentChallenge: {
    id: string;
    realm: string;
    method: "lightning";
    intent: "charge";
    request: string;
    expires: string;
  };
  invoice: string;
  paymentHash: string;
  amountSats: number;
}

export type PaymentDecision =
  | {
      type: "allow";
    }
  | {
      type: "deny";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    };

const denyFromError = (error: AgentPayError): PaymentDecision => {
  return {
    type: "deny",
    status: error.status,
    body: error.toResponseBody(),
  };
};

const createPaymentRequiredBody = (
  challenge: Omit<PaymentChallengeBody, "error">,
): PaymentChallengeBody => {
  return {
    error: {
      code: "payment_required",
      message: "Payment required",
    },
    ...challenge,
  };
};

const readHeaderValue = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  return undefined;
};

const readXPaymentHeader = (request: unknown): string | undefined => {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const nodeLikeHeaders = (request as { headers?: Record<string, unknown> }).headers;
  if (nodeLikeHeaders && typeof nodeLikeHeaders === "object") {
    for (const [name, value] of Object.entries(nodeLikeHeaders)) {
      if (name.toLowerCase() === "x-payment") {
        return readHeaderValue(value);
      }
    }
  }

  const webHeaders = (request as { headers?: Headers }).headers;
  if (webHeaders && typeof webHeaders.get === "function") {
    return webHeaders.get("x-payment") ?? undefined;
  }

  const honoRequest = (request as {
    req?: { header?: (name: string) => string | undefined; raw?: Request };
  }).req;

  if (honoRequest?.header) {
    return honoRequest.header("x-payment");
  }

  return honoRequest?.raw?.headers.get("x-payment") ?? undefined;
};

const resolveRequestResource = (request: unknown, fallbackPath: string): string => {
  if (request && typeof request === "object") {
    const url = (request as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) {
      return url;
    }

    const honoRaw = (request as { req?: { raw?: Request } }).req?.raw;
    if (honoRaw?.url) {
      return honoRaw.url;
    }
  }

  return fallbackPath;
};

const createX402PaymentRequiredBody = (
  challenge: X402PaymentRequirement,
  resource: string,
): X402ChallengeBody => {
  return {
    x402Version: 1,
    accepts: [challenge],
    resource,
  };
};

const createMppPaymentRequiredBody = (challenge: Omit<MppChallengeBody, "error">): MppChallengeBody => {
  return {
    error: {
      code: "payment_required",
      message: "Payment required",
    },
    ...challenge,
  };
};

const readHostHeader = (request: unknown): string | undefined => {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const nodeLikeHeaders = (request as { headers?: Record<string, unknown> }).headers;
  if (nodeLikeHeaders && typeof nodeLikeHeaders === "object") {
    for (const [name, value] of Object.entries(nodeLikeHeaders)) {
      if (name.toLowerCase() === "host") {
        return readHeaderValue(value);
      }
    }
  }

  const webHeaders = (request as { headers?: Headers }).headers;
  if (webHeaders && typeof webHeaders.get === "function") {
    return webHeaders.get("host") ?? undefined;
  }

  const honoRequest = (request as {
    req?: { header?: (name: string) => string | undefined; raw?: Request };
  }).req;

  if (honoRequest?.header) {
    return honoRequest.header("host");
  }

  return honoRequest?.raw?.headers.get("host") ?? undefined;
};

const resolveRequestRealm = (request: unknown): string => {
  if (request && typeof request === "object") {
    const url = (request as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    }

    const honoRaw = (request as { req?: { raw?: Request } }).req?.raw;
    if (honoRaw?.url) {
      return new URL(honoRaw.url).host;
    }
  }

  return readHostHeader(request) ?? "localhost";
};

const readPaymentAuthorizationToken = (
  authorizationHeader: string | undefined,
): string | null => {
  if (!authorizationHeader) {
    return null;
  }

  const [schemeRaw, tokenRaw] = authorizationHeader.split(/\s+/, 2);
  if (!schemeRaw || !tokenRaw) {
    return null;
  }

  if (schemeRaw.toLowerCase() !== "payment") {
    return null;
  }

  return tokenRaw;
};

export const createPaymentMiddlewareFoundation = <RequestLike>(
  config: PaymentConfig<RequestLike>,
): PaymentMiddlewareFoundation<RequestLike> => {
  const resolvedConfig = resolvePaymentConfig(config);
  const tokenStore = resolvedConfig.tokenStore;
  const mppChargeChallenges = new Map<
    string,
    {
      chargeId: string;
      paymentHash: string;
      amountSats: number;
      resource: string;
      expiresAt: number;
      challenge: {
        id: string;
        realm: string;
        method: "lightning";
        intent: "charge";
        request: string;
        expires: string;
      };
      consumed: boolean;
    }
  >();

  const evaluateRequest: PaymentMiddlewareFoundation<RequestLike>["evaluateRequest"] =
    async (request, context) => {
      let amountSats: number;
      try {
        amountSats = await resolvedConfig.amount(request);
      } catch {
        return denyFromError(createPricingError());
      }

      const parsed = parseAuthorizationHeader(context.authorizationHeader);
      const paymentToken = readPaymentAuthorizationToken(context.authorizationHeader);
      const isUsdcMode = resolvedConfig.currency === "USDC";

      if (isUsdcMode && !parsed) {
        try {
          const btcUsdRate = await getBtcUsdRate();
          const amountUsdc = satsToUsdcAmount(amountSats, btcUsdRate);
          const x402Requirement = await createX402Charge(config, amountUsdc, context.resourcePath);
          const paymentPayload = readXPaymentHeader(request);

          if (paymentPayload) {
            const verified = await verifyX402Payment(
              config,
              paymentPayload,
              x402Requirement,
            );
            if (verified) {
              return {
                type: "allow",
              };
            }
          }

          return {
            type: "deny",
            status: createPaymentRequiredError().status,
            body: createX402PaymentRequiredBody(
              x402Requirement,
              resolveRequestResource(request, context.resourcePath),
            ),
            headers: {
              "Content-Type": "application/json",
            },
          };
        } catch (error) {
          if (error instanceof AgentPayError && error.code === "configuration_error") {
            return denyFromError(error);
          }

          const reason = error instanceof Error ? error.message : undefined;
          return denyFromError(createInvoiceCreationFailedError(reason));
        }
      }

      if (resolvedConfig.protocol === "MPP" && !paymentToken) {
        try {
          const challenge = await createCharge({
            apiKey: resolvedConfig.apiKey,
            amountSats,
            resourcePath: context.resourcePath,
          });

          const challengeId = crypto.randomUUID();
          const realm = resolveRequestRealm(request);
          const expires = new Date(challenge.expiresAt * 1000).toISOString();
          const requestToken = encodePaymentRequest({
            amount: String(amountSats),
            currency: "sat",
            description: context.resourcePath,
            methodDetails: {
              invoice: challenge.invoice,
              paymentHash: challenge.paymentHash,
              network: "mainnet",
            },
          });

          const paymentChallenge = {
            id: challengeId,
            realm,
            method: "lightning" as const,
            intent: "charge" as const,
            request: requestToken,
            expires,
          };

          mppChargeChallenges.set(challengeId, {
            chargeId: challenge.chargeId,
            paymentHash: challenge.paymentHash,
            amountSats,
            resource: context.resourcePath,
            expiresAt: challenge.expiresAt,
            challenge: paymentChallenge,
            consumed: false,
          });

          return {
            type: "deny",
            status: createPaymentRequiredError().status,
            headers: {
              "WWW-Authenticate": `Payment id="${challengeId}", realm="${realm}", method="lightning", intent="charge", request="${requestToken}", expires="${expires}"`,
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
            body: createMppPaymentRequiredBody({
              paymentChallenge,
              invoice: challenge.invoice,
              paymentHash: challenge.paymentHash,
              amountSats,
            }),
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : undefined;
          return denyFromError(createInvoiceCreationFailedError(reason));
        }
      }

      if (resolvedConfig.protocol === "MPP" && paymentToken) {
        let credential;
        try {
          credential = decodePaymentCredential<LightningChargeCredentialPayload>(paymentToken);
        } catch {
          return denyFromError(createInvalidCredentialError());
        }

        if (credential.challenge.method !== "lightning" || credential.challenge.intent !== "charge") {
          return denyFromError(createInvalidCredentialError());
        }

        const stored = mppChargeChallenges.get(credential.challenge.id);
        if (!stored || stored.consumed) {
          return denyFromError(createInvalidCredentialError());
        }

        const matchesChallenge =
          stored.challenge.id === credential.challenge.id &&
          stored.challenge.realm === credential.challenge.realm &&
          stored.challenge.method === credential.challenge.method &&
          stored.challenge.intent === credential.challenge.intent &&
          stored.challenge.request === credential.challenge.request &&
          stored.challenge.expires === credential.challenge.expires;

        if (!matchesChallenge) {
          return denyFromError(createInvalidCredentialError());
        }

        const now = Math.floor(Date.now() / 1000);
        if (stored.expiresAt <= now) {
          return denyFromError(createTokenExpiredError());
        }

        if (stored.resource !== context.resourcePath || stored.amountSats !== amountSats) {
          return denyFromError(createAmountMismatchError());
        }

        const computedHash = createPaymentHash(credential.payload.preimage);
        if (computedHash !== stored.paymentHash) {
          return denyFromError(createInvalidPaymentProofError());
        }

        const settledFromStore = await tokenStore.isSettled(
          stored.chargeId,
          stored.paymentHash,
        );

        if (!settledFromStore) {
          const charge = await getCharge({
            apiKey: resolvedConfig.apiKey,
            chargeId: stored.chargeId,
          });

          if (!charge.settled || charge.paymentHash !== stored.paymentHash) {
            return denyFromError(createInvalidPaymentProofError());
          }

          await tokenStore.markSettled({
            chargeId: stored.chargeId,
            paymentHash: stored.paymentHash,
            amountSats: stored.amountSats,
            expiresAt: stored.expiresAt,
            resource: stored.resource,
          });
        }

        stored.consumed = true;

        return {
          type: "allow",
        };
      }

      if (!parsed) {
        try {
          const challenge = await createCharge({
            apiKey: resolvedConfig.apiKey,
            amountSats,
            resourcePath: context.resourcePath,
          });

          const macaroon = createMacaroon(
            {
              chargeId: challenge.chargeId,
              resource: context.resourcePath,
              amountSats,
              expiresAt: challenge.expiresAt,
              paymentHash: challenge.paymentHash,
            },
            resolvedConfig.apiKey,
          );

          const body = createPaymentRequiredBody({
            macaroon,
            invoice: challenge.invoice,
            paymentHash: challenge.paymentHash,
            amountSats,
            expiresAt: challenge.expiresAt,
          });

          return {
            type: "deny",
            status: createPaymentRequiredError().status,
            headers: {
              "WWW-Authenticate": `L402 macaroon="${macaroon}", invoice="${challenge.invoice}"`,
            },
            body,
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : undefined;
          return denyFromError(createInvoiceCreationFailedError(reason));
        }
      }

      const payload = verifyMacaroon(parsed.macaroon, resolvedConfig.apiKey);
      if (!payload) {
        return denyFromError(createInvalidCredentialError());
      }

      if (payload.resource !== context.resourcePath) {
        return denyFromError(createResourceMismatchError());
      }

      if (payload.amountSats !== amountSats) {
        return denyFromError(createAmountMismatchError());
      }

      const now = Math.floor(Date.now() / 1000);
      if (payload.expiresAt <= now) {
        return denyFromError(createTokenExpiredError());
      }

      const computedHash = createPaymentHash(parsed.preimage);
      if (computedHash !== payload.paymentHash) {
        return denyFromError(createInvalidPaymentProofError());
      }

      const settledFromStore = await tokenStore.isSettled(
        payload.chargeId,
        payload.paymentHash,
      );

      if (!settledFromStore) {
        const charge = await getCharge({
          apiKey: resolvedConfig.apiKey,
          chargeId: payload.chargeId,
        });

        if (!charge.settled || charge.paymentHash !== payload.paymentHash) {
          return denyFromError(createInvalidPaymentProofError());
        }

        await tokenStore.markSettled({
          chargeId: payload.chargeId,
          paymentHash: payload.paymentHash,
          amountSats: payload.amountSats,
          expiresAt: payload.expiresAt,
          resource: payload.resource,
        });
      }

      return {
        type: "allow",
      };
    };

  return {
    config: resolvedConfig,
    evaluateRequest,
  };
};
