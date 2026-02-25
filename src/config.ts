import { createConfigurationError } from "./errors.js";
import type { PaymentConfig, ResolvedPaymentConfig } from "./types.js";
import os from "node:os";
import path from "node:path";

const resolveAmount = <RequestLike>(
  amount: PaymentConfig<RequestLike>["amount"],
): ResolvedPaymentConfig<RequestLike>["amount"] => {
  if (typeof amount === "function") {
    return async (request: RequestLike): Promise<number> => {
      const resolved = await amount(request);
      return resolved;
    };
  }

  return async (): Promise<number> => amount;
};

export const resolvePaymentConfig = <RequestLike>(
  config: PaymentConfig<RequestLike>,
): ResolvedPaymentConfig<RequestLike> => {
  const apiKey = config.apiKey ?? process.env.ZBD_API_KEY;

  if (!apiKey) {
    throw createConfigurationError();
  }

  return {
    apiKey,
    amount: resolveAmount(config.amount),
    currency: config.currency ?? "SAT",
    tokenStorePath:
      config.tokenStorePath ??
      path.join(os.homedir(), ".zbd-wallet", "server-tokens.json"),
  };
};
