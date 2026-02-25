import { createPaymentMiddlewareFoundation } from "./core.js";
import type { PaymentConfig } from "./types.js";

export interface ExpressRequestLike {
  path?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ExpressResponseLike {
  status(code: number): this;
  json(payload: unknown): this;
  setHeader?(name: string, value: string): void;
}

export type ExpressNext = (error?: unknown) => void;

export type ExpressMiddleware = (
  request: ExpressRequestLike,
  response: ExpressResponseLike,
  next: ExpressNext,
) => void | Promise<void>;

const getHeaderValue = (
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined => {
  if (!headers) {
    return undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  return undefined;
};

const normalizeResourcePath = (request: ExpressRequestLike): string => {
  const raw = request.path ?? request.originalUrl ?? "/";
  const queryIndex = raw.indexOf("?");
  if (queryIndex >= 0) {
    return raw.slice(0, queryIndex) || "/";
  }
  return raw;
};

export const createExpressPaymentMiddleware = (
  config: PaymentConfig<ExpressRequestLike>,
): ExpressMiddleware => {
  const foundation = createPaymentMiddlewareFoundation(config);

  return async (request, response, next): Promise<void> => {
    const decision = await foundation.evaluateRequest(request, {
      authorizationHeader: getHeaderValue(request.headers, "authorization"),
      resourcePath: normalizeResourcePath(request),
    });

    if (decision.type === "deny") {
      if (decision.headers) {
        for (const [name, value] of Object.entries(decision.headers)) {
          response.setHeader?.(name, value);
        }
      }

      response.status(decision.status).json(decision.body);
      return;
    }

    next();
  };
};
