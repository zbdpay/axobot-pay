import { createServer } from "node:http";
import { createPaymentMiddlewareFoundation } from "../dist/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration from environment
const port = Number(process.env.PORT ?? "8787");
const amountSats = Number(process.env.ZBD_PRICE_SATS ?? "21");
const debugEnabled = /^(1|true|yes|on)$/i.test(process.env.ZBD_PAY_DEBUG ?? "");
const protocol = process.env.AXOPAY_PROTOCOL ?? "L402"; // L402 or MPP
const mppIntent = process.env.AXOPAY_MPP_INTENT ?? "charge"; // charge or session (for MPP)

// Debug logging
const debugLog = (...values) => {
  if (!debugEnabled) return;
  console.log("[axo-pay:debug]", ...values);
};

// Create middleware foundation instances for different endpoints
const createFoundation = (opts = {}) => {
  return createPaymentMiddlewareFoundation({
    amount: opts.amount ?? amountSats,
    apiKey: process.env.ZBD_API_KEY,
    tokenStorePath: process.env.ZBD_TOKEN_STORE_PATH,
    protocol: opts.protocol ?? protocol,
    mppIntent: opts.mppIntent ?? mppIntent,
    description: opts.description,
  });
};

// Foundation instances for different endpoints
const foundations = {
  basic: createFoundation({ description: "Basic protected content" }),
  premium: createFoundation({ 
    amount: 100, 
    description: "Premium content (100 sats)",
    protocol: "L402"
  }),
  mpp: createFoundation({ 
    amount: 50, 
    description: "MPP payment test",
    protocol: "MPP",
    mppIntent: "charge"
  }),
  mppSession: createFoundation({
    amount: 10,
    description: "MPP Session test",
    protocol: "MPP",
    mppIntent: "session"
  }),
};

// Helper to send JSON responses
const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
};

// Helper to send HTML
const sendHtml = (res, status, html) => {
  res.writeHead(status, { "content-type": "text/html" });
  res.end(html);
};

// Demo HTML page
const demoHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AxoPay Test Server</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; border-bottom: 2px solid #F7931A; padding-bottom: 10px; }
    .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 8px; }
    .endpoint h3 { margin-top: 0; color: #F7931A; }
    code { background: #e0e0e0; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    pre { background: #2d2d2d; color: #fff; padding: 15px; border-radius: 8px; overflow-x: auto; }
    .info { background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .warning { background: #fff3e0; padding: 15px; border-radius: 8px; margin: 20px 0; }
  </style>
</head>
<body>
  <h1>🎉 AxoPay Test Server</h1>
  
  <div class="info">
    <strong>Server is running!</strong> Use the endpoints below to test axoPay integration.
  </div>

  <div class="warning">
    <strong>Testing with axo CLI:</strong><br>
    Make sure you have the <code>axo</code> CLI installed and configured with your ZBD API key.
  </div>

  <h2>Available Endpoints</h2>

  <div class="endpoint">
    <h3>🔒 /protected</h3>
    <p>Basic L402-protected endpoint (${amountSats} sats)</p>
    <pre>axo fetch "<span id="host"></span>/protected" --max-sats ${amountSats}</pre>
  </div>

  <div class="endpoint">
    <h3>💎 /premium</h3>
    <p>Premium content (100 sats, L402)</p>
    <pre>axo fetch "<span id="host2"></span>/premium" --max-sats 100</pre>
  </div>

  <div class="endpoint">
    <h3>⚡ /mpp-charge</h3>
    <p>MPP protocol single charge (50 sats)</p>
    <pre>axo fetch "<span id="host3"></span>/mpp-charge" --max-sats 50</pre>
  </div>

  <div class="endpoint">
    <h3>🔁 /mpp-session</h3>
    <p>MPP session-based payments (10 sats)</p>
    <pre>axo fetch "<span id="host4"></span>/mpp-session" --max-sats 10</pre>
  </div>

  <div class="endpoint">
    <h3>❤️ /health</h3>
    <p>Health check endpoint (no payment required)</p>
    <pre>curl "<span id="host5"></span>/health"</pre>
  </div>

  <h2>Configuration</h2>
  <ul>
    <li><strong>Default Price:</strong> ${amountSats} sats</li>
    <li><strong>Protocol:</strong> ${protocol}</li>
    ${protocol === "MPP" ? `<li><strong>MPP Intent:</strong> ${mppIntent}</li>` : ""}
    <li><strong>Debug Mode:</strong> ${debugEnabled ? "Enabled" : "Disabled"}</li>
  </ul>

  <script>
    const host = window.location.origin;
    document.querySelectorAll("[id^='host']").forEach(el => el.textContent = host);
  </script>
</body>
</html>
`;

// Request handler
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  debugLog("request", {
    method: req.method,
    path,
    host: req.headers.host,
    hasAuthorization: typeof req.headers.authorization === "string",
  });

  // CORS headers for ngrok/public access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Demo page (root)
  if (path === "/") {
    sendHtml(res, 200, demoHtml);
    return;
  }

  // Health check
  if (path === "/health") {
    sendJson(res, 200, { 
      ok: true, 
      server: "axo-pay-ngrok",
      timestamp: new Date().toISOString(),
      config: {
        defaultAmount: amountSats,
        protocol,
        mppIntent: protocol === "MPP" ? mppIntent : undefined,
      }
    });
    return;
  }

  // Determine which foundation to use based on path
  let foundation;
  let endpointName;
  switch (path) {
    case "/protected":
      foundation = foundations.basic;
      endpointName = "basic";
      break;
    case "/premium":
      foundation = foundations.premium;
      endpointName = "premium";
      break;
    case "/mpp-charge":
      foundation = foundations.mpp;
      endpointName = "mpp-charge";
      break;
    case "/mpp-session":
      foundation = foundations.mppSession;
      endpointName = "mpp-session";
      break;
    default:
      sendJson(res, 404, {
        error: "not_found",
        message: "Use /, /health, /protected, /premium, /mpp-charge, or /mpp-session",
      });
      return;
  }

  // Evaluate payment
  try {
    const decision = await foundation.evaluateRequest(req, {
      authorizationHeader: req.headers.authorization,
      resourcePath: path,
    });

    if (decision.type === "deny") {
      debugLog("deny", {
        endpoint: endpointName,
        status: decision.status,
        errorCode: decision.body?.error?.code,
      });
      sendJson(res, decision.status, decision.body, decision.headers);
      return;
    }

    debugLog("allow", { endpoint: endpointName, path });

    // Return success response
    const responseBody = {
      ok: true,
      endpoint: endpointName,
      resource: path,
      paid: true,
      message: getSuccessMessage(endpointName),
    };

    // Add protocol-specific info
    if (endpointName.startsWith("mpp")) {
      responseBody.protocol = "MPP";
      responseBody.intent = endpointName === "mpp-session" ? "session" : "charge";
    } else {
      responseBody.protocol = "L402";
    }

    sendJson(res, 200, responseBody);

  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    debugLog("exception", { endpoint: endpointName, message });
    sendJson(res, 500, {
      error: "server_error",
      message,
    });
  }
});

function getSuccessMessage(endpoint) {
  const messages = {
    basic: "✅ Basic L402 payment verified! Content unlocked.",
    premium: "💎 Premium content unlocked! Thanks for the 100 sats.",
    "mpp-charge": "⚡ MPP charge payment accepted! Single payment verified.",
    "mpp-session": "🔁 MPP session active! You have access to session-based content.",
  };
  return messages[endpoint] || "Payment verified!";
}

server.listen(port, () => {
  console.log("\n🚀 AxoPay Ngrok Test Server");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Local:    http://localhost:${port}`);
  console.log(`Health:   http://localhost:${port}/health`);
  console.log("");
  console.log("Protected Endpoints:");
  console.log(`  http://localhost:${port}/protected  (${amountSats} sats, L402)`);
  console.log(`  http://localhost:${port}/premium    (100 sats, L402)`);
  console.log(`  http://localhost:${port}/mpp-charge (50 sats, MPP charge)`);
  console.log(`  http://localhost:${port}/mpp-session (10 sats, MPP session)`);
  console.log("");
  console.log("Demo Page:");
  console.log(`  http://localhost:${port}/`);
  console.log("");
  console.log("Environment:");
  console.log(`  Default Amount: ${amountSats} sats`);
  console.log(`  Protocol: ${protocol}`);
  if (protocol === "MPP") {
    console.log(`  MPP Intent: ${mppIntent}`);
  }
  console.log(`  Debug: ${debugEnabled ? "enabled" : "disabled"}`);
  console.log("");
  console.log("To expose via ngrok:");
  console.log(`  ngrok http ${port}`);
  console.log("");
  console.log("Test with axo CLI:");
  console.log(`  axo fetch "http://localhost:${port}/protected" --max-sats ${amountSats}`);
  console.log("═══════════════════════════════════════════════════\n");
});
