import type { PaymentErrorBody } from "./types.js";

export class AxoPayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AxoPayError";
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

export const createConfigurationError = (): AxoPayError => {
  return new AxoPayError(
    "configuration_error",
    "ZBD_API_KEY is required to initialize middleware",
    500,
  );
};

export const createPaymentRequiredError = (): AxoPayError => {
  return new AxoPayError("payment_required", "Payment required", 402);
};

export const createInvalidCredentialError = (): AxoPayError => {
  return new AxoPayError("invalid_credential", "Invalid credential", 401);
};

export const createInvalidPaymentProofError = (): AxoPayError => {
  return new AxoPayError(
    "invalid_payment_proof",
    "Invalid payment proof",
    401,
  );
};

export const createResourceMismatchError = (): AxoPayError => {
  return new AxoPayError(
    "resource_mismatch",
    "Token resource does not match request",
    403,
  );
};

export const createAmountMismatchError = (): AxoPayError => {
  return new AxoPayError(
    "amount_mismatch",
    "Token amount does not match current price",
    403,
  );
};

export const createTokenExpiredError = (): AxoPayError => {
  return new AxoPayError("token_expired", "Token has expired", 403);
};

export const createPricingError = (): AxoPayError => {
  return new AxoPayError("pricing_error", "Failed to resolve price", 500);
};

export const createInvoiceCreationFailedError = (
  reason?: string,
): AxoPayError => {
  const message =
    typeof reason === "string" && reason.trim().length > 0
      ? `Failed to create payment challenge (${reason})`
      : "Failed to create payment challenge";

  return new AxoPayError(
    "invoice_creation_failed",
    message,
    502,
  );
};
