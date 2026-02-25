import { createPaymentMiddlewareFoundation } from "./core.js";
import type { PaymentConfig } from "./types.js";

export type NextRouteHandler<Context = unknown> = (
  request: Request,
  context: Context,
) => Response | Promise<Response>;

export const withPaymentRequired = <Context = unknown>(
  config: PaymentConfig<Request>,
  handler: NextRouteHandler<Context>,
): NextRouteHandler<Context> => {
  const foundation = createPaymentMiddlewareFoundation(config);

  return async (request: Request, context: Context): Promise<Response> => {
    const decision = await foundation.evaluateRequest(request, {
      authorizationHeader: request.headers.get("authorization") ?? undefined,
      resourcePath: new URL(request.url).pathname,
    });

    if (decision.type === "deny") {
      const responseInit: ResponseInit = {
        status: decision.status,
      };
      if (decision.headers) {
        responseInit.headers = decision.headers;
      }

      return Response.json(decision.body, {
        ...responseInit,
      });
    }

    return await handler(request, context);
  };
};
