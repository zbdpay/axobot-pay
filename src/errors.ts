import type { PaymentErrorBody } from "./types.js";

export class AgentPayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AgentPayError";
    this.code = code;
    this.status = status;
  }

  toResponseBody(): PaymentErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

export const createConfigurationError = (): AgentPayError => {
  return new AgentPayError(
    "configuration_error",
    "ZBD_API_KEY is required to initialize middleware",
    500,
  );
};

export const createPaymentRequiredError = (): AgentPayError => {
  return new AgentPayError("payment_required", "Payment required", 402);
};

export const createInvalidCredentialError = (): AgentPayError => {
  return new AgentPayError("invalid_credential", "Invalid credential", 401);
};

export const createInvalidPaymentProofError = (): AgentPayError => {
  return new AgentPayError(
    "invalid_payment_proof",
    "Invalid payment proof",
    401,
  );
};

export const createResourceMismatchError = (): AgentPayError => {
  return new AgentPayError(
    "resource_mismatch",
    "Token resource does not match request",
    403,
  );
};

export const createAmountMismatchError = (): AgentPayError => {
  return new AgentPayError(
    "amount_mismatch",
    "Token amount does not match current price",
    403,
  );
};

export const createTokenExpiredError = (): AgentPayError => {
  return new AgentPayError("token_expired", "Token has expired", 403);
};

export const createPricingError = (): AgentPayError => {
  return new AgentPayError("pricing_error", "Failed to resolve price", 500);
};

export const createInvoiceCreationFailedError = (
  reason?: string,
): AgentPayError => {
  const message =
    typeof reason === "string" && reason.trim().length > 0
      ? `Failed to create payment challenge (${reason})`
      : "Failed to create payment challenge";

  return new AgentPayError(
    "invoice_creation_failed",
    message,
    502,
  );
};
