import { AgentPayError } from "./errors.js";
import type { PaymentConfig } from "./types.js";

const DEFAULT_BTC_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

let cachedRate: { value: number; expiresAt: number } | null = null;

const readObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }

  return {};
};

const normalizeProviderUrl = (url: string): string => {
  return url.replace(/\/+$/, "");
};

const resolveProviderConfig = (
  config: Pick<PaymentConfig<unknown>, "usdcProviderUrl" | "usdcProviderApiKey">,
): { url: string; apiKey: string } => {
  const url = (config.usdcProviderUrl ?? process.env.USDC_PROVIDER_URL ?? "").trim();
  const apiKey = (
    config.usdcProviderApiKey ?? process.env.USDC_PROVIDER_API_KEY ?? ""
  ).trim();

  if (!url) {
    throw new AgentPayError(
      "configuration_error",
      "USDC provider URL is required for USDC middleware",
      500,
    );
  }

  if (!apiKey) {
    throw new AgentPayError(
      "configuration_error",
      "USDC provider API key is required for USDC middleware",
      500,
    );
  }

  return {
    url: normalizeProviderUrl(url),
    apiKey,
  };
};

const readErrorSummary = async (response: Response): Promise<string> => {
  const status = `${response.status}`;

  try {
    const payload = await response.text();
    if (payload.trim().length === 0) {
      return status;
    }

    try {
      const parsed = JSON.parse(payload) as unknown;
      const root = readObject(parsed);
      const message = root.error ?? root.message;
      if (typeof message === "string" && message.length > 0) {
        return `${status}: ${message}`;
      }
    } catch {
      return `${status}: ${payload.trim()}`;
    }
  } catch {
    return status;
  }

  return status;
};

const roundDivide = (numerator: bigint, denominator: bigint): bigint => {
  return (numerator + denominator / 2n) / denominator;
};

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

const isX402PaymentRequirement = (value: unknown): value is X402PaymentRequirement => {
  const node = readObject(value);
  return (
    typeof node.scheme === "string" &&
    typeof node.network === "string" &&
    typeof node.maxAmountRequired === "string" &&
    typeof node.resource === "string" &&
    typeof node.payTo === "string" &&
    typeof node.asset === "string" &&
    typeof node.maxTimeoutSeconds === "number"
  );
};

export const getBtcUsdRate = async (): Promise<number> => {
  const now = Date.now();
  if (cachedRate && cachedRate.expiresAt > now) {
    return cachedRate.value;
  }

  const response = await fetch(DEFAULT_BTC_PRICE_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch BTC/USD rate (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  const root = readObject(payload);
  const bitcoin = readObject(root.bitcoin);
  const usd = bitcoin.usd;

  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new Error("Invalid BTC/USD rate response");
  }

  cachedRate = {
    value: usd,
    expiresAt: now + 60_000,
  };

  return usd;
};

export const satsToUsdcAmount = (sats: number, btcUsdRate: number): string => {
  if (!Number.isFinite(sats) || sats <= 0) {
    throw new Error("Sats amount must be a positive number");
  }

  if (!Number.isFinite(btcUsdRate) || btcUsdRate <= 0) {
    throw new Error("BTC/USD rate must be a positive number");
  }

  const satsBigInt = BigInt(Math.round(sats));
  if (satsBigInt <= 0n) {
    throw new Error("Sats amount must be positive");
  }

  const rateMicros = Math.round(btcUsdRate * 1_000_000);
  if (!Number.isFinite(rateMicros) || rateMicros <= 0) {
    throw new Error("BTC/USD rate precision is invalid");
  }

  const numerator = satsBigInt * BigInt(rateMicros) * 1_000_000n;
  const denominator = 100_000_000n * 1_000_000n;

  return roundDivide(numerator, denominator).toString();
};

export const createX402Charge = async (
  config: Pick<PaymentConfig<unknown>, "usdcProviderUrl" | "usdcProviderApiKey">,
  amountUsdc: string,
  resource: string,
): Promise<X402PaymentRequirement> => {
  const provider = resolveProviderConfig(config);

  const response = await fetch(`${provider.url}/api/charge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
    },
    body: JSON.stringify({
      amountUsdc,
      resource,
    }),
  });

  if (!response.ok) {
    const summary = await readErrorSummary(response);
    throw new Error(`USDC provider /api/charge request failed (${summary})`);
  }

  const payload = (await response.json()) as unknown;
  const root = readObject(payload);
  const success = root.success;
  const requirement = readObject(root.paymentRequirement);

  if (success !== true || !isX402PaymentRequirement(requirement)) {
    throw new Error("Malformed x402 charge response");
  }

  return requirement;
};

export const verifyX402Payment = async (
  config: Pick<PaymentConfig<unknown>, "usdcProviderUrl" | "usdcProviderApiKey">,
  paymentPayload: string,
  paymentRequirement: X402PaymentRequirement,
): Promise<boolean> => {
  const provider = resolveProviderConfig(config);

  const response = await fetch(`${provider.url}/api/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
    },
    body: JSON.stringify({
      paymentPayload,
      paymentRequirement,
    }),
  });

  if (!response.ok) {
    const summary = await readErrorSummary(response);
    throw new Error(`USDC provider /api/verify request failed (${summary})`);
  }

  const payload = (await response.json()) as unknown;
  const root = readObject(payload);
  return root.success === true && root.verified === true;
};
