import { resolvePaymentConfig } from "./config.js";
import {
  createAmountMismatchError,
  createInvalidCredentialError,
  createInvalidPaymentProofError,
  createInvoiceCreationFailedError,
  createPaymentRequiredError,
  createPricingError,
  createResourceMismatchError,
  createTokenExpiredError,
  type AgentPayError,
} from "./errors.js";
import {
  createMacaroon,
  createPaymentHash,
  parseAuthorizationHeader,
  verifyMacaroon,
} from "./l402.js";
import { FileTokenStore } from "./token-store.js";
import type { PaymentConfig, ResolvedPaymentConfig } from "./types.js";
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

export const createPaymentMiddlewareFoundation = <RequestLike>(
  config: PaymentConfig<RequestLike>,
): PaymentMiddlewareFoundation<RequestLike> => {
  const resolvedConfig = resolvePaymentConfig(config);
  const tokenStore = new FileTokenStore(resolvedConfig.tokenStorePath);

  const evaluateRequest: PaymentMiddlewareFoundation<RequestLike>["evaluateRequest"] =
    async (request, context) => {
      let amountSats: number;
      try {
        amountSats = await resolvedConfig.amount(request);
      } catch {
        return denyFromError(createPricingError());
      }

      const parsed = parseAuthorizationHeader(context.authorizationHeader);

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
