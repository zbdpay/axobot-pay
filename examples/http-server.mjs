import { createServer } from "node:http";
import { createPaymentMiddlewareFoundation } from "../dist/index.js";

const port = Number(process.env.PORT ?? "8787");
const amountSats = Number(process.env.ZBD_PRICE_SATS ?? "21");
const debugEnabled = /^(1|true|yes|on)$/i.test(process.env.ZBD_PAY_DEBUG ?? "");

const debugLog = (...values) => {
  if (!debugEnabled) {
    return;
  }

  console.log("[agent-pay:debug]", ...values);
};

const foundation = createPaymentMiddlewareFoundation({
  amount: amountSats,
  apiKey: process.env.ZBD_API_KEY,
  tokenStorePath: process.env.ZBD_TOKEN_STORE_PATH,
});

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  debugLog("request", {
    method: req.method,
    path: url.pathname,
    hasAuthorization: typeof req.headers.authorization === "string",
    authorizationPrefix:
      typeof req.headers.authorization === "string"
        ? req.headers.authorization.slice(0, 18)
        : null,
  });

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== "/protected") {
    sendJson(res, 404, {
      error: "not_found",
      message: "Use /protected or /health",
    });
    return;
  }

  try {
    const decision = await foundation.evaluateRequest(req, {
      authorizationHeader: req.headers.authorization,
      resourcePath: url.pathname,
    });

    if (decision.type === "deny") {
      debugLog("deny", {
        status: decision.status,
        errorCode:
          typeof decision.body === "object" && decision.body && "error" in decision.body
            ? decision.body.error?.code
            : undefined,
        message:
          typeof decision.body === "object" && decision.body && "error" in decision.body
            ? decision.body.error?.message
            : undefined,
      });
      sendJson(res, decision.status, decision.body, decision.headers);
      return;
    }

    debugLog("allow", {
      path: url.pathname,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    debugLog("exception", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    sendJson(res, 500, {
      error: "server_error",
      message,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    resource: "/protected",
    price_sats: amountSats,
    paid: true,
  });
});

server.listen(port, () => {
  console.log(`agent-pay example listening on http://localhost:${port}`);
  console.log(`protected endpoint: http://localhost:${port}/protected`);
  console.log("set ZBD_PAY_DEBUG=1 for verbose logs");
  console.log("test with zbdw:");
  console.log(`zbdw fetch \"http://localhost:${port}/protected\" --max-sats ${amountSats}`);
});
