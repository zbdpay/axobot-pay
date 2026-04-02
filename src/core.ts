import {
  createZbdLightningAdapter,
  decodePaymentCredential,
  decodeLightningSessionRequest,
  encodePaymentRequest,
  refundLightningSessionBalance,
  type LightningChargeCredentialPayload,
  type LightningSessionCredentialPayload,
  type PaymentChallengeContext,
} from "@axobot/mppx";
import crypto from "node:crypto";
import { resolvePaymentConfig } from "./config.js";
import {
  AxoPayError,
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
import type {
  PaymentConfig,
  ResolvedPaymentConfig,
} from "./types.js";
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

type MppChallengeContext = PaymentChallengeContext & {
  method: "lightning";
  intent: "charge" | "session";
};

export interface MppChargeChallengeBody {
  error: {
    code: "payment_required";
    message: string;
  };
  paymentChallenge: MppChallengeContext;
  invoice: string;
  paymentHash: string;
  amountSats: number;
}

export interface MppSessionChallengeBody {
  error: {
    code: "payment_required";
    message: string;
  };
  paymentChallenge: MppChallengeContext;
  depositInvoice: string;
  paymentHash: string;
  amountSats: number;
  depositSats: number;
  idleTimeoutSeconds: number;
  sessionId?: string | undefined;
  reason?: "new_session" | "insufficient_balance" | "session_idle" | undefined;
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
    }
  | {
      type: "respond";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    };

const denyFromError = (error: AxoPayError): PaymentDecision => {
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

const createMppChargeBody = (
  challenge: Omit<MppChargeChallengeBody, "error">,
): MppChargeChallengeBody => {
  return {
    error: {
      code: "payment_required",
      message: "Payment required",
    },
    ...challenge,
  };
};

const createMppSessionBody = (
  challenge: Omit<MppSessionChallengeBody, "error">,
): MppSessionChallengeBody => {
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

const createMppAuthenticateHeader = (challenge: MppChallengeContext): string => {
  return `Payment id="${challenge.id}", realm="${challenge.realm}", method="${challenge.method}", intent="${challenge.intent}", request="${challenge.request}", expires="${challenge.expires ?? ""}"`;
};

const calculateDepositSats = (amountSats: number, multiplier: number): number => {
  return Math.max(amountSats, Math.ceil(amountSats * multiplier));
};

const extendIdleTimeout = (nowMs: number, idleTimeoutSeconds: number): string => {
  return new Date(nowMs + idleTimeoutSeconds * 1000).toISOString();
};

const isIsoExpired = (value: string | undefined | null, nowMs: number): boolean => {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return parsed <= nowMs;
};

const buildSessionCloseBody = (input: {
  sessionId: string;
  status: "closed" | "refund_failed";
  refundedSats: number;
  refundStatus: "pending" | "succeeded" | "failed" | "skipped";
  refundReference?: string | null | undefined;
}): Record<string, unknown> => {
  return {
    sessionId: input.sessionId,
    status: input.status,
    refundedSats: input.refundedSats,
    refundStatus: input.refundStatus,
    refundReference: input.refundReference ?? null,
  };
};

export const createPaymentMiddlewareFoundation = <RequestLike>(
  config: PaymentConfig<RequestLike>,
): PaymentMiddlewareFoundation<RequestLike> => {
  const resolvedConfig = resolvePaymentConfig(config);
  const tokenStore = resolvedConfig.tokenStore;
  const mppSessionStore = resolvedConfig.mppSessionStore;

  const ensureMppChallengeMatches = async (
    challenge: PaymentChallengeContext,
    amountSats: number,
    resourcePath: string,
    options?: { requireUnconsumed?: boolean | undefined },
  ) => {
    const stored = await mppSessionStore.getChallenge(challenge.id);
    if (!stored) {
      throw createInvalidCredentialError();
    }

    if (options?.requireUnconsumed !== false && stored.consumed) {
      throw createInvalidCredentialError();
    }

    const expectedExpires = new Date(stored.expiresAt * 1000).toISOString();
    if (
      challenge.id !== stored.id ||
      challenge.realm !== stored.realm ||
      challenge.method !== "lightning" ||
      challenge.intent !== stored.intent ||
      challenge.request !== stored.request ||
      (challenge.expires ?? "") !== expectedExpires
    ) {
      throw createInvalidCredentialError();
    }

    const now = Math.floor(Date.now() / 1000);
    if (stored.expiresAt <= now) {
      throw createTokenExpiredError();
    }

    if (stored.resource !== resourcePath) {
      throw createResourceMismatchError();
    }

    if (stored.amountSats !== amountSats) {
      throw createAmountMismatchError();
    }

    return stored;
  };

  const ensureChargeSettled = async (input: {
    chargeId: string;
    paymentHash: string;
    amountSats: number;
    expiresAt: number;
    resource: string;
  }): Promise<void> => {
    const settledFromStore = await tokenStore.isSettled(input.chargeId, input.paymentHash);
    if (!settledFromStore) {
      const charge = await getCharge({
        apiKey: resolvedConfig.apiKey,
        chargeId: input.chargeId,
      });

      if (!charge.settled || charge.paymentHash !== input.paymentHash) {
        throw createInvalidPaymentProofError();
      }

      await tokenStore.markSettled({
        chargeId: input.chargeId,
        paymentHash: input.paymentHash,
        amountSats: input.amountSats,
        expiresAt: input.expiresAt,
        resource: input.resource,
      });
    }
  };

  const issueMppChargeChallenge = async (input: {
    request: RequestLike;
    resourcePath: string;
    amountSats: number;
  }): Promise<PaymentDecision> => {
    try {
      const challenge = await createCharge({
        apiKey: resolvedConfig.apiKey,
        amountSats: input.amountSats,
        resourcePath: input.resourcePath,
      });

      const challengeId = crypto.randomUUID();
      const realm = resolveRequestRealm(input.request);
      const expires = new Date(challenge.expiresAt * 1000).toISOString();
      const requestToken = encodePaymentRequest({
        amount: String(input.amountSats),
        currency: "sat",
        description: input.resourcePath,
        methodDetails: {
          invoice: challenge.invoice,
          paymentHash: challenge.paymentHash,
          network: "mainnet",
        },
      });

      const paymentChallenge: MppChallengeContext = {
        id: challengeId,
        realm,
        method: "lightning",
        intent: "charge",
        request: requestToken,
        expires,
      };

      await mppSessionStore.saveChallenge({
        id: challengeId,
        intent: "charge",
        realm,
        request: requestToken,
        resource: input.resourcePath,
        paymentHash: challenge.paymentHash,
        chargeId: challenge.chargeId,
        amountSats: input.amountSats,
        depositSats: input.amountSats,
        expiresAt: challenge.expiresAt,
        consumed: false,
      });

      return {
        type: "deny",
        status: createPaymentRequiredError().status,
        headers: {
          "WWW-Authenticate": createMppAuthenticateHeader(paymentChallenge),
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: createMppChargeBody({
          paymentChallenge,
          invoice: challenge.invoice,
          paymentHash: challenge.paymentHash,
          amountSats: input.amountSats,
        }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : undefined;
      return denyFromError(createInvoiceCreationFailedError(reason));
    }
  };

  const issueMppSessionChallenge = async (input: {
    request: RequestLike;
    resourcePath: string;
    amountSats: number;
    sessionId?: string | undefined;
    reason?: "new_session" | "insufficient_balance" | "session_idle" | undefined;
  }): Promise<PaymentDecision> => {
    try {
      const depositSats = calculateDepositSats(
        input.amountSats,
        resolvedConfig.mppDepositMultiplier,
      );
      const challenge = await createCharge({
        apiKey: resolvedConfig.apiKey,
        amountSats: depositSats,
        resourcePath: input.resourcePath,
      });

      const challengeId = crypto.randomUUID();
      const realm = resolveRequestRealm(input.request);
      const expires = new Date(challenge.expiresAt * 1000).toISOString();
      const requestToken = encodePaymentRequest({
        amount: String(input.amountSats),
        currency: "sat",
        description: input.resourcePath,
        unitType: resolvedConfig.mppUnitType ?? undefined,
        methodDetails: {
          depositInvoice: challenge.invoice,
          paymentHash: challenge.paymentHash,
          depositAmount: String(depositSats),
          idleTimeout: String(resolvedConfig.mppIdleTimeoutSeconds),
        },
      });

      const paymentChallenge: MppChallengeContext = {
        id: challengeId,
        realm,
        method: "lightning",
        intent: "session",
        request: requestToken,
        expires,
      };

      await mppSessionStore.saveChallenge({
        id: challengeId,
        sessionId: input.sessionId,
        intent: "session",
        realm,
        request: requestToken,
        resource: input.resourcePath,
        paymentHash: challenge.paymentHash,
        chargeId: challenge.chargeId,
        amountSats: input.amountSats,
        depositSats,
        expiresAt: challenge.expiresAt,
        consumed: false,
      });

      return {
        type: "deny",
        status: createPaymentRequiredError().status,
        headers: {
          "WWW-Authenticate": createMppAuthenticateHeader(paymentChallenge),
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: createMppSessionBody({
          paymentChallenge,
          depositInvoice: challenge.invoice,
          paymentHash: challenge.paymentHash,
          amountSats: input.amountSats,
          depositSats,
          idleTimeoutSeconds: resolvedConfig.mppIdleTimeoutSeconds,
          sessionId: input.sessionId,
          reason: input.reason,
        }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : undefined;
      return denyFromError(createInvoiceCreationFailedError(reason));
    }
  };

  const handleMppChargeCredential = async (
    credential: {
      challenge: PaymentChallengeContext;
      payload: LightningChargeCredentialPayload;
    },
    amountSats: number,
    resourcePath: string,
  ): Promise<PaymentDecision> => {
    const stored = await ensureMppChallengeMatches(credential.challenge, amountSats, resourcePath, {
      requireUnconsumed: true,
    });

    const computedHash = createPaymentHash(credential.payload.preimage);
    if (computedHash !== stored.paymentHash) {
      throw createInvalidPaymentProofError();
    }

    await ensureChargeSettled({
      chargeId: stored.chargeId,
      paymentHash: stored.paymentHash,
      amountSats: stored.amountSats,
      expiresAt: stored.expiresAt,
      resource: stored.resource,
    });

    await mppSessionStore.saveChallenge({
      ...stored,
      consumed: true,
    });

    return {
      type: "allow",
    };
  };

  const handleMppSessionCredential = async (
    request: RequestLike,
    credential: {
      challenge: PaymentChallengeContext;
      payload: LightningSessionCredentialPayload;
    },
    amountSats: number,
    resourcePath: string,
  ): Promise<PaymentDecision> => {
    const storedChallenge = await ensureMppChallengeMatches(
      credential.challenge,
      amountSats,
      resourcePath,
      {
        requireUnconsumed:
          credential.payload.action === "open" || credential.payload.action === "topUp",
      },
    );
    const action = credential.payload.action;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (action === "open") {
      const computedHash = createPaymentHash(credential.payload.preimage);
      if (computedHash !== storedChallenge.paymentHash) {
        throw createInvalidPaymentProofError();
      }

      await ensureChargeSettled({
        chargeId: storedChallenge.chargeId,
        paymentHash: storedChallenge.paymentHash,
        amountSats: storedChallenge.depositSats,
        expiresAt: storedChallenge.expiresAt,
        resource: storedChallenge.resource,
      });

      const sessionRequest = decodeLightningSessionRequest(credential.challenge);
      const sessionId = sessionRequest.methodDetails.paymentHash;

      await mppSessionStore.saveSession({
        sessionId,
        resource: storedChallenge.resource,
        realm: storedChallenge.realm,
        paymentHash: storedChallenge.paymentHash,
        bearerSecret: credential.payload.preimage,
        chargeId: storedChallenge.chargeId,
        status: "open",
        unitAmountSats: amountSats,
        unitType: resolvedConfig.mppUnitType,
        depositSats: storedChallenge.depositSats,
        spentSats: amountSats,
        returnInvoice: credential.payload.returnInvoice ?? null,
        returnLightningAddress: credential.payload.returnLightningAddress ?? null,
        openedAt: nowIso,
        lastActivityAt: nowIso,
        idleTimeoutAt: extendIdleTimeout(nowMs, resolvedConfig.mppIdleTimeoutSeconds),
        closedAt: null,
        refundSats: null,
        refundStatus: null,
        refundReference: null,
      });

      await mppSessionStore.saveChallenge({
        ...storedChallenge,
        consumed: true,
      });

      return {
        type: "allow",
      };
    }

    const session = await mppSessionStore.getSession(credential.payload.sessionId);
    if (!session) {
      throw createInvalidCredentialError();
    }

    if (session.resource !== resourcePath) {
      throw createResourceMismatchError();
    }

    if (action === "bearer") {
      if (session.status !== "open") {
        throw createInvalidCredentialError();
      }

      if (isIsoExpired(session.idleTimeoutAt, nowMs)) {
        await mppSessionStore.saveSession({
          ...session,
          status: "paused",
          lastActivityAt: nowIso,
        });
        return issueMppSessionChallenge({
          request,
          resourcePath,
          amountSats,
          sessionId: session.sessionId,
          reason: "session_idle",
        });
      }

      const computedHash = createPaymentHash(credential.payload.preimage);
      if (computedHash !== session.paymentHash) {
        throw createInvalidPaymentProofError();
      }

      const availableSats = session.depositSats - session.spentSats;
      if (availableSats < amountSats) {
        return issueMppSessionChallenge({
          request,
          resourcePath,
          amountSats,
          sessionId: session.sessionId,
          reason: "insufficient_balance",
        });
      }

      await mppSessionStore.saveSession({
        ...session,
        status: "open",
        unitAmountSats: amountSats,
        spentSats: session.spentSats + amountSats,
        lastActivityAt: nowIso,
        idleTimeoutAt: extendIdleTimeout(nowMs, resolvedConfig.mppIdleTimeoutSeconds),
      });

      return {
        type: "allow",
      };
    }

    if (action === "topUp") {
      if (session.status !== "open" && session.status !== "paused") {
        throw createInvalidCredentialError();
      }

      const computedHash = createPaymentHash(credential.payload.topUpPreimage);
      if (computedHash !== storedChallenge.paymentHash) {
        throw createInvalidPaymentProofError();
      }

      await ensureChargeSettled({
        chargeId: storedChallenge.chargeId,
        paymentHash: storedChallenge.paymentHash,
        amountSats: storedChallenge.depositSats,
        expiresAt: storedChallenge.expiresAt,
        resource: storedChallenge.resource,
      });

      await mppSessionStore.saveSession({
        ...session,
        status: "open",
        unitAmountSats: amountSats,
        depositSats: session.depositSats + storedChallenge.depositSats,
        spentSats: session.spentSats + amountSats,
        lastActivityAt: nowIso,
        idleTimeoutAt: extendIdleTimeout(nowMs, resolvedConfig.mppIdleTimeoutSeconds),
      });

      await mppSessionStore.saveChallenge({
        ...storedChallenge,
        consumed: true,
      });

      return {
        type: "allow",
      };
    }

    if (action === "close") {
      if (session.status !== "open" && session.status !== "paused") {
        throw createInvalidCredentialError();
      }

      const computedHash = createPaymentHash(credential.payload.preimage);
      if (computedHash !== session.paymentHash) {
        throw createInvalidPaymentProofError();
      }

      const refundSats = Math.max(0, session.depositSats - session.spentSats);
      const adapter = createZbdLightningAdapter({
        apiKey: resolvedConfig.apiKey,
        zbdApiBaseUrl: process.env.ZBD_API_BASE_URL,
      });

      let refundStatus: "pending" | "succeeded" | "failed" | "skipped" = "skipped";
      let refundReference: string | null = null;
      let responseStatus = 200;
      let responseBody: Record<string, unknown>;

      try {
        if (refundSats > 0) {
          const refund = await refundLightningSessionBalance({
            adapter,
            amountSats: refundSats,
            returnInvoice: session.returnInvoice ?? undefined,
            returnLightningAddress: session.returnLightningAddress ?? undefined,
          });
          refundStatus = "succeeded";
          refundReference = refund.paymentId ?? refund.paymentHash;
        }

        await mppSessionStore.saveSession({
          ...session,
          status: "closed",
          closedAt: nowIso,
          lastActivityAt: nowIso,
          refundSats,
          refundStatus,
          refundReference,
        });

        await mppSessionStore.saveChallenge({
          ...storedChallenge,
          consumed: true,
        });

        responseBody = buildSessionCloseBody({
          sessionId: session.sessionId,
          status: "closed",
          refundedSats: refundSats,
          refundStatus,
          refundReference,
        });
      } catch (error) {
        refundStatus = "failed";
        responseStatus = 502;

        await mppSessionStore.saveSession({
          ...session,
          status: "refund_failed",
          closedAt: nowIso,
          lastActivityAt: nowIso,
          refundSats,
          refundStatus,
          refundReference,
        });

        responseBody = {
          error: {
            code: "refund_failed",
            message:
              error instanceof Error ? error.message : "Session refund failed",
          },
          ...buildSessionCloseBody({
            sessionId: session.sessionId,
            status: "refund_failed",
            refundedSats: refundSats,
            refundStatus,
            refundReference,
          }),
        };
      }

      return {
        type: "respond",
        status: responseStatus,
        headers: {
          "Content-Type": "application/json",
        },
        body: responseBody,
      };
    }

    throw createInvalidCredentialError();
  };

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
          if (error instanceof AxoPayError && error.code === "configuration_error") {
            return denyFromError(error);
          }

          const reason = error instanceof Error ? error.message : undefined;
          return denyFromError(createInvoiceCreationFailedError(reason));
        }
      }

      if (resolvedConfig.protocol === "MPP" && !paymentToken) {
        if (resolvedConfig.mppIntent === "session") {
          return issueMppSessionChallenge({
            request,
            resourcePath: context.resourcePath,
            amountSats,
            reason: "new_session",
          });
        }
        return issueMppChargeChallenge({
          request,
          resourcePath: context.resourcePath,
          amountSats,
        });
      }

      if (resolvedConfig.protocol === "MPP" && paymentToken) {
        let credential;
        try {
          credential = decodePaymentCredential<
            LightningChargeCredentialPayload | LightningSessionCredentialPayload
          >(paymentToken);
        } catch {
          return denyFromError(createInvalidCredentialError());
        }

        try {
          if (credential.challenge.method !== "lightning") {
            return denyFromError(createInvalidCredentialError());
          }

          if (credential.challenge.intent === "charge") {
            return await handleMppChargeCredential(
              credential as {
                challenge: PaymentChallengeContext;
                payload: LightningChargeCredentialPayload;
              },
              amountSats,
              context.resourcePath,
            );
          }

          if (credential.challenge.intent === "session") {
            return await handleMppSessionCredential(
              request,
              credential as {
                challenge: PaymentChallengeContext;
                payload: LightningSessionCredentialPayload;
              },
              amountSats,
              context.resourcePath,
            );
          }

          return denyFromError(createInvalidCredentialError());
        } catch (error) {
          if (error instanceof AxoPayError) {
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
