const DEFAULT_ZBD_API_BASE = "https://api.zbdpay.com";

const getZbdApiBase = (): string => {
  const configured = process.env.ZBD_API_BASE_URL;
  if (typeof configured === "string") {
    const normalized = configured.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return DEFAULT_ZBD_API_BASE;
};

const readObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
};

const getString = (
  data: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
};

const getNumber = (
  data: Record<string, unknown>,
  keys: string[],
): number | null => {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
};

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const payload = (await response.json()) as unknown;
  const root = readObject(payload);
  const nestedData = readObject(root.data);
  if (Object.keys(nestedData).length > 0) {
    return nestedData;
  }
  return root;
};

export interface CreatedCharge {
  chargeId: string;
  invoice: string;
  paymentHash: string;
  expiresAt: number;
}

export interface CreateChargeInput {
  apiKey: string;
  amountSats: number;
  resourcePath: string;
}

export const createCharge = async (
  input: CreateChargeInput,
): Promise<CreatedCharge> => {
  const response = await fetch(`${getZbdApiBase()}/v0/charges`, {
    method: "POST",
    headers: {
      apikey: input.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amountSats * 1000,
      amountMsat: input.amountSats * 1000,
      internalDescription: input.resourcePath,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to create charge");
  }

  const data = await parseJson(response);
  const invoiceNode = readObject(data.invoice);

  const chargeId = getString(data, ["id", "chargeId"]);
  const invoice =
    getString(invoiceNode, ["request", "paymentRequest"]) ??
    getString(data, ["invoice", "paymentRequest"]);
  const paymentHash = getString(data, ["paymentHash", "hash", "payment_hash"]);
  const expiresAt =
    getNumber(data, ["expiresAt", "expiration", "expires_at"]) ??
    Math.floor(Date.now() / 1000) + 300;

  if (!chargeId || !invoice || !paymentHash) {
    throw new Error("Malformed charge response");
  }

  return {
    chargeId,
    invoice,
    paymentHash,
    expiresAt,
  };
};

export interface ChargeStatus {
  settled: boolean;
  paymentHash: string;
}

const isSettledStatus = (status: string | null): boolean => {
  if (!status) {
    return false;
  }

  const normalized = status.toLowerCase();
  return (
    normalized === "paid" ||
    normalized === "completed" ||
    normalized === "settled"
  );
};

export const getCharge = async (input: {
  apiKey: string;
  chargeId: string;
}): Promise<ChargeStatus> => {
  const response = await fetch(`${getZbdApiBase()}/v0/charges/${input.chargeId}`, {
    method: "GET",
    headers: {
      apikey: input.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch charge");
  }

  const data = await parseJson(response);

  const status = getString(data, ["status", "state"]);
  const paidAt = getString(data, ["paidAt", "paid_at"]);
  const paymentHash = getString(data, ["paymentHash", "hash", "payment_hash"]);

  if (!paymentHash) {
    throw new Error("Missing payment hash in charge response");
  }

  return {
    settled: isSettledStatus(status) || typeof paidAt === "string",
    paymentHash,
  };
};
