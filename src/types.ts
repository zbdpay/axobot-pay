import type { TokenStore } from "./token-store.js";

export type PaymentCurrency = "SAT" | "USD" | "USDC";
export type PaymentProtocol = "L402" | "MPP";

export type PaymentAmount<RequestLike> =
  | number
  | ((request: RequestLike) => number | Promise<number>);

export interface PaymentConfig<RequestLike = unknown> {
  amount: PaymentAmount<RequestLike>;
  currency?: PaymentCurrency;
  protocol?: PaymentProtocol;
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
