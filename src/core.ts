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

export const createPaymentMiddlewareFoundation = <RequestLike>(
  config: PaymentConfig<RequestLike>,
): PaymentMiddlewareFoundation<RequestLike> => {
  const resolvedConfig = resolvePaymentConfig(config);
  const tokenStore = resolvedConfig.tokenStore;

  const evaluateRequest: PaymentMiddlewareFoundation<RequestLike>["evaluateRequest"] =
    async (request, context) => {
      let amountSats: number;
      try {
        amountSats = await resolvedConfig.amount(request);
      } catch {
        return denyFromError(createPricingError());
      }

      const parsed = parseAuthorizationHeader(context.authorizationHeader);
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
