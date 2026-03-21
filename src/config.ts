import { createConfigurationError } from "./errors.js";
import { FileMppSessionStore } from "./mpp-session-store.js";
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
  const mppSessionStorePath =
    config.mppSessionStorePath ??
    (config.mppSessionStore
      ? ""
      : path.join(os.homedir(), ".zbd-wallet", "mpp-sessions.json"));
  const mppSessionStore =
    config.mppSessionStore ?? new FileMppSessionStore(mppSessionStorePath);

  return {
    apiKey,
    amount: resolveAmount(config.amount),
    currency: config.currency ?? "SAT",
    protocol: config.protocol ?? "L402",
    mppIntent: config.mppIntent ?? "charge",
    mppDepositMultiplier:
      typeof config.mppDepositMultiplier === "number" &&
      Number.isFinite(config.mppDepositMultiplier) &&
      config.mppDepositMultiplier >= 1
        ? config.mppDepositMultiplier
        : 10,
    mppIdleTimeoutSeconds:
      typeof config.mppIdleTimeoutSeconds === "number" &&
      Number.isFinite(config.mppIdleTimeoutSeconds) &&
      config.mppIdleTimeoutSeconds > 0
        ? Math.floor(config.mppIdleTimeoutSeconds)
        : 3600,
    mppUnitType:
      typeof config.mppUnitType === "string" && config.mppUnitType.trim().length > 0
        ? config.mppUnitType.trim()
        : null,
    mppSessionStorePath,
    mppSessionStore,
    tokenStorePath,
    tokenStore,
  };
};
