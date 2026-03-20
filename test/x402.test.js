import test from "node:test";
import assert from "node:assert/strict";

import {
  createPaymentMiddlewareFoundation,
  createX402Charge,
  satsToUsdcAmount,
  verifyX402Payment,
} from "../dist/index.js";

const withMockFetch = async (fetchImpl, handler) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  try {
    await handler();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

test("satsToUsdcAmount converts sats into USDC micros", () => {
  assert.equal(satsToUsdcAmount(100_000_000, 2), "2000000");
  assert.equal(satsToUsdcAmount(50_000_000, 1.5), "750000");
});

test("x402 provider helpers call the configured provider endpoints", async () => {
  const requirement = {
    scheme: "x402",
    network: "lightning",
    maxAmountRequired: "250000",
    resource: "/protected",
    payTo: "usdc-provider",
    asset: "USDC",
    maxTimeoutSeconds: 120,
  };
  const calls = [];

  await withMockFetch(async (url, options = {}) => {
    calls.push({ url: url.toString(), options });

    if (url.toString() === "https://provider.test/api/charge") {
      return new Response(
        JSON.stringify({
          success: true,
          paymentRequirement: requirement,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.toString() === "https://provider.test/api/verify") {
      return new Response(
        JSON.stringify({
          success: true,
          verified: true,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const charge = await createX402Charge(
      {
        usdcProviderUrl: "https://provider.test/",
        usdcProviderApiKey: "provider-key",
      },
      "250000",
      "/protected",
    );

    assert.deepEqual(charge, requirement);

    const verified = await verifyX402Payment(
      {
        usdcProviderUrl: "https://provider.test/",
        usdcProviderApiKey: "provider-key",
      },
      "payload",
      requirement,
    );

    assert.equal(verified, true);
    assert.equal(calls[0].url, "https://provider.test/api/charge");
    assert.equal(calls[0].options.headers["x-api-key"], "provider-key");
    assert.equal(calls[1].url, "https://provider.test/api/verify");
    assert.equal(calls[1].options.headers["x-api-key"], "provider-key");
  });
});

test("x402 provider helpers fail closed when provider config is missing", async () => {
  await assert.rejects(
    () =>
      createX402Charge(
        {
          usdcProviderUrl: "",
          usdcProviderApiKey: "provider-key",
        },
        "250000",
        "/protected",
      ),
    (error) => {
      assert.equal(error.code, "configuration_error");
      return true;
    },
  );
});

test("USDC middleware emits x402 challenges and allows verified x-payment requests", async () => {
  const requirement = {
    scheme: "x402",
    network: "lightning",
    maxAmountRequired: "2000000",
    resource: "/protected",
    payTo: "usdc-provider",
    asset: "USDC",
    maxTimeoutSeconds: 120,
  };
  const calls = [];

  await withMockFetch(async (url, options = {}) => {
    calls.push({ url: url.toString(), options });

    if (url.toString() === "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd") {
      return new Response(JSON.stringify({ bitcoin: { usd: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.toString() === "https://provider.test/api/charge") {
      return new Response(
        JSON.stringify({
          success: true,
          paymentRequirement: requirement,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.toString() === "https://provider.test/api/verify") {
      return new Response(
        JSON.stringify({
          success: true,
          verified: true,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const foundation = createPaymentMiddlewareFoundation({
      amount: 100_000_000,
      currency: "USDC",
      apiKey: "test-key",
      usdcProviderUrl: "https://provider.test/",
      usdcProviderApiKey: "provider-key",
    });

    const challenge = await foundation.evaluateRequest(
      new Request("https://example.com/protected"),
      {
        authorizationHeader: undefined,
        resourcePath: "/protected",
      },
    );

    assert.equal(challenge.type, "deny");
    assert.equal(challenge.status, 402);
    assert.equal(challenge.body.x402Version, 1);
    assert.equal(challenge.body.resource, "https://example.com/protected");
    assert.equal(challenge.body.accepts[0].resource, "/protected");

    const allowed = await foundation.evaluateRequest(
      new Request("https://example.com/protected", {
        headers: {
          "x-payment": "verified-payload",
        },
      }),
      {
        authorizationHeader: undefined,
        resourcePath: "/protected",
      },
    );

    assert.equal(allowed.type, "allow");
    assert.equal(calls.some((call) => call.url === "https://provider.test/api/verify"), true);
  });
});
