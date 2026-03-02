import type { TokenStore } from "./token-store.js";

export type PaymentCurrency = "SAT" | "USD";

export type PaymentAmount<RequestLike> =
  | number
  | ((request: RequestLike) => number | Promise<number>);

export interface PaymentConfig<RequestLike = unknown> {
  amount: PaymentAmount<RequestLike>;
  currency?: PaymentCurrency;
  apiKey?: string;
  tokenStorePath?: string;
  tokenStore?: TokenStore;
}

export interface ResolvedPaymentConfig<RequestLike = unknown> {
  amount: (request: RequestLike) => Promise<number>;
  currency: PaymentCurrency;
  apiKey: string;
  tokenStorePath: string;
  tokenStore: TokenStore;
}

export interface PaymentErrorBody {
  error: {
    code: string;
    message: string;
  };
}
