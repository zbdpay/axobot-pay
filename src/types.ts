import type { TokenStore } from "./token-store.js";
import type { MppSessionStore } from "./mpp-session-store.js";

export type PaymentCurrency = "SAT" | "USD" | "USDC";
export type PaymentProtocol = "L402" | "MPP";
export type MppIntent = "charge" | "session";

export type PaymentAmount<RequestLike> =
  | number
  | ((request: RequestLike) => number | Promise<number>);

export interface PaymentConfig<RequestLike = unknown> {
  amount: PaymentAmount<RequestLike>;
  currency?: PaymentCurrency;
  protocol?: PaymentProtocol;
  mppIntent?: MppIntent;
  mppDepositMultiplier?: number;
  mppIdleTimeoutSeconds?: number;
  mppUnitType?: string;
  mppSessionStorePath?: string;
  mppSessionStore?: MppSessionStore;
  apiKey?: string;
  usdcProviderUrl?: string;
  usdcProviderApiKey?: string;
  tokenStorePath?: string;
  tokenStore?: TokenStore;
}

export interface ResolvedPaymentConfig<RequestLike = unknown> {
  amount: (request: RequestLike) => Promise<number>;
  currency: PaymentCurrency;
  protocol: PaymentProtocol;
  mppIntent: MppIntent;
  mppDepositMultiplier: number;
  mppIdleTimeoutSeconds: number;
  mppUnitType: string | null;
  mppSessionStorePath: string;
  mppSessionStore: MppSessionStore;
  apiKey: string;
  usdcProviderUrl?: string;
  usdcProviderApiKey?: string;
  tokenStorePath: string;
  tokenStore: TokenStore;
}

export interface PaymentErrorBody {
  error: {
    code: string;
    message: string;
  };
}
