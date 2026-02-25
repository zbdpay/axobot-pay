import crypto from "node:crypto";

export interface MacaroonPayload {
  chargeId: string;
  resource: string;
  amountSats: number;
  expiresAt: number;
  paymentHash: string;
}

export interface ParsedAuthorization {
  scheme: "L402" | "LSAT";
  macaroon: string;
  preimage: string;
}

const toBase64Url = (value: string): string => {
  return Buffer.from(value, "utf8").toString("base64url");
};

const fromBase64Url = (value: string): string => {
  return Buffer.from(value, "base64url").toString("utf8");
};

const createSignature = (encodedPayload: string, secret: string): string => {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
};

export const createMacaroon = (
  payload: MacaroonPayload,
  secret: string,
): string => {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = createSignature(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
};

export const verifyMacaroon = (
  macaroon: string,
  secret: string,
): MacaroonPayload | null => {
  const parts = macaroon.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createSignature(encodedPayload, secret);
  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload)) as Partial<
      MacaroonPayload
    >;

    if (
      typeof parsed.chargeId !== "string" ||
      typeof parsed.resource !== "string" ||
      typeof parsed.amountSats !== "number" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.paymentHash !== "string"
    ) {
      return null;
    }

    return {
      chargeId: parsed.chargeId,
      resource: parsed.resource,
      amountSats: parsed.amountSats,
      expiresAt: parsed.expiresAt,
      paymentHash: parsed.paymentHash,
    };
  } catch {
    return null;
  }
};

export const parseAuthorizationHeader = (
  authorizationHeader: string | undefined,
): ParsedAuthorization | null => {
  if (!authorizationHeader) {
    return null;
  }

  const [schemeRaw, credentialRaw] = authorizationHeader.split(/\s+/, 2);
  if (!schemeRaw || !credentialRaw) {
    return null;
  }

  const scheme = schemeRaw.toUpperCase();
  if (scheme !== "L402" && scheme !== "LSAT") {
    return null;
  }

  const [macaroon, preimage] = credentialRaw.split(":", 2);
  if (!macaroon || !preimage) {
    return null;
  }

  return {
    scheme,
    macaroon,
    preimage,
  };
};

export const createPaymentHash = (preimage: string): string => {
  return crypto.createHash("sha256").update(preimage, "utf8").digest("hex");
};
