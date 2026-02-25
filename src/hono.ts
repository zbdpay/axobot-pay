import { createPaymentMiddlewareFoundation } from "./core.js";
import type { PaymentConfig } from "./types.js";

export interface HonoContextLike {
  req: {
    path?: string;
    raw?: Request;
    header?(name: string): string | undefined;
  };
  header?(name: string, value: string): void;
  json(payload: unknown, status?: number): Response | Promise<Response>;
}

export type HonoNext = () => Promise<void>;

export type HonoMiddleware = (
  context: HonoContextLike,
  next: HonoNext,
) => Promise<void>;

export const createHonoPaymentMiddleware = (
  config: PaymentConfig<HonoContextLike>,
): HonoMiddleware => {
  const foundation = createPaymentMiddlewareFoundation(config);

  return async (context, next): Promise<void> => {
    const resourcePath =
      context.req.path ??
      (context.req.raw ? new URL(context.req.raw.url).pathname : "/");

    const authorizationHeader =
      context.req.header?.("authorization") ??
      context.req.raw?.headers.get("authorization") ??
      undefined;

    const decision = await foundation.evaluateRequest(context, {
      authorizationHeader,
      resourcePath,
    });

    if (decision.type === "deny") {
      if (decision.headers) {
        for (const [name, value] of Object.entries(decision.headers)) {
          context.header?.(name, value);
        }
      }

      await context.json(decision.body, decision.status);
      return;
    }

    await next();
  };
};
