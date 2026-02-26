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

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const decodeBech32Words = (value: string): number[] => {
  const words: number[] = [];
  for (const char of value) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid bech32 character");
    }
    words.push(index);
  }
  return words;
};

const wordsToBytes = (words: number[]): Uint8Array => {
  let bitBuffer = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const word of words) {
    bitBuffer = (bitBuffer << 5) | word;
    bitCount += 5;

    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >> bitCount) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
};

const bytesToHex = (bytes: Uint8Array): string => {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

const extractPaymentHashFromBolt11 = (rawInvoice: string): string | null => {
  const invoice = rawInvoice.toLowerCase().startsWith("lightning:")
    ? rawInvoice.slice("lightning:".length)
    : rawInvoice;

  const normalized = invoice.toLowerCase();
  const separatorIndex = normalized.lastIndexOf("1");
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 7) {
    return null;
  }

  const dataAndChecksum = normalized.slice(separatorIndex + 1);
  if (dataAndChecksum.length <= 6) {
    return null;
  }

  const payloadWords = decodeBech32Words(dataAndChecksum.slice(0, -6));
  if (payloadWords.length <= 7 + 104) {
    return null;
  }

  let index = 7;
  while (index + 3 <= payloadWords.length - 104) {
    const tagValue = payloadWords[index];
    const lengthHigh = payloadWords[index + 1];
    const lengthLow = payloadWords[index + 2];
    if (
      typeof tagValue !== "number" ||
      typeof lengthHigh !== "number" ||
      typeof lengthLow !== "number"
    ) {
      return null;
    }

    const length = (lengthHigh << 5) + lengthLow;
    index += 3;

    if (length < 0 || index + length > payloadWords.length - 104) {
      return null;
    }

    const tag = BECH32_CHARSET[tagValue] ?? "";
    const words = payloadWords.slice(index, index + length);
    index += length;

    if (tag === "p") {
      const bytes = wordsToBytes(words);
      if (bytes.length >= 32) {
        return bytesToHex(bytes.slice(0, 32));
      }
      return null;
    }
  }

  return null;
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

const readErrorSummary = async (response: Response): Promise<string> => {
  const status = `${response.status}`;
  let message = "";

  try {
    const payload = await response.text();
    if (payload.trim().length > 0) {
      try {
        const parsed = JSON.parse(payload) as unknown;
        const root = readObject(parsed);
        const nested = readObject(root.data);
        message =
          getString(nested, ["message", "error"]) ??
          getString(root, ["message", "error"]) ??
          "";
      } catch {
        message = payload.trim();
      }
    }
  } catch {
    message = "";
  }

  if (message.length > 0) {
    return `${status}: ${message}`;
  }

  return status;
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
      description: input.resourcePath,
    }),
  });

  if (!response.ok) {
    const summary = await readErrorSummary(response);
    throw new Error(`ZBD API /v0/charges request failed (${summary})`);
  }

  const data = await parseJson(response);
  const invoiceNode = readObject(data.invoice);

  const chargeId = getString(data, ["id", "chargeId"]);
  const invoice =
    getString(invoiceNode, ["request", "paymentRequest"]) ??
    getString(data, ["invoice", "paymentRequest"]);
  const paymentHash =
    getString(data, ["paymentHash", "hash", "payment_hash"]) ??
    getString(invoiceNode, ["paymentHash", "hash", "payment_hash"]) ??
    (invoice ? extractPaymentHashFromBolt11(invoice) : null);
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
  const invoiceNode = readObject(data.invoice);

  const status = getString(data, ["status", "state"]);
  const paidAt = getString(data, ["paidAt", "paid_at"]);
  const invoice =
    getString(invoiceNode, ["request", "paymentRequest"]) ??
    getString(data, ["invoice", "paymentRequest"]);
  const paymentHash =
    getString(data, ["paymentHash", "hash", "payment_hash"]) ??
    getString(invoiceNode, ["paymentHash", "hash", "payment_hash"]) ??
    (invoice ? extractPaymentHashFromBolt11(invoice) : null);

  if (!paymentHash) {
    throw new Error("Missing payment hash in charge response");
  }

  return {
    settled: isSettledStatus(status) || typeof paidAt === "string",
    paymentHash,
  };
};
