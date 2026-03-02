import { createConfigurationError } from "./errors.js";
import { FileTokenStore } from "./token-store.js";
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

  const tokenStorePath =
    config.tokenStorePath ??
    (config.tokenStore
      ? ""
      : path.join(os.homedir(), ".zbd-wallet", "server-tokens.json"));
  const tokenStore = config.tokenStore ?? new FileTokenStore(tokenStorePath);

  return {
    apiKey,
    amount: resolveAmount(config.amount),
    currency: config.currency ?? "SAT",
    tokenStorePath,
    tokenStore,
  };
};
