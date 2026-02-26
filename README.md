# @zbdpay/agent-pay

Framework adapters and core logic for L402 payment-gated HTTP routes.

Supports:
- Express middleware
- Hono middleware
- Next.js route wrapper (`@zbdpay/agent-pay/next`)

## Requirements

- Node.js `>=22`
- npm

## Install

```bash
npm install @zbdpay/agent-pay
```

## Quick Start

### Express

```ts
import express from "express";
import { createExpressPaymentMiddleware } from "@zbdpay/agent-pay";

const app = express();

app.get(
  "/protected",
  createExpressPaymentMiddleware({
    amount: 21,
    apiKey: process.env.ZBD_API_KEY,
  }),
  (_req, res) => {
    res.json({ ok: true });
  },
);
```

### Hono

```ts
import { Hono } from "hono";
import { createHonoPaymentMiddleware } from "@zbdpay/agent-pay";

const app = new Hono();

app.use(
  "/protected",
  createHonoPaymentMiddleware({
    amount: 21,
    apiKey: process.env.ZBD_API_KEY,
  }),
);
```

### Next.js Route Handlers

```ts
import { withPaymentRequired } from "@zbdpay/agent-pay/next";

export const GET = withPaymentRequired(
  {
    amount: 21,
    apiKey: process.env.ZBD_API_KEY,
  },
  async () => Response.json({ ok: true }),
);
```

## Config (`PaymentConfig`)

- `amount`: number or async resolver function
- `currency`: `"SAT" | "USD"` (default `"SAT"`)
- `apiKey`: optional, falls back to `ZBD_API_KEY`
- `tokenStorePath`: optional, defaults to `~/.zbd-wallet/server-tokens.json`

## Runtime Environment

- `ZBD_API_KEY`: required unless passed via config
- `ZBD_API_BASE_URL`: optional, default `https://api.zbdpay.com`

## Examples

- `examples/http-server.mjs`: minimal Node HTTP server using `createPaymentMiddlewareFoundation`

Run locally from this repo:

```bash
npm run build
ZBD_API_KEY=<your_api_key> npm run example:http-server
```

Enable verbose host-side debug logs:

```bash
ZBD_PAY_DEBUG=1 ZBD_API_KEY=<your_api_key> npm run example:http-server
```

In a second terminal, consume the paid route with your local wallet CLI:

```bash
zbdw fetch "http://localhost:8787/protected" --max-sats 100
```

## L402 Flow

When a request has no valid auth proof:

1. Middleware creates a charge (`/v0/charges`)
2. Returns `402` with:
   - JSON body: `payment_required` + challenge fields
   - `WWW-Authenticate` header: `L402 macaroon="...", invoice="..."`

When a request has auth proof:

1. Parse `Authorization` (`L402` or `LSAT`)
2. Verify signed macaroon payload
3. Verify resource path, amount, expiry, payment hash
4. Confirm charge settlement via ZBD API
5. Allow or deny request

## Error Codes

`error.code` may be:

- `configuration_error`
- `payment_required`
- `invalid_credential`
- `invalid_payment_proof`
- `resource_mismatch`
- `amount_mismatch`
- `token_expired`
- `pricing_error`
- `invoice_creation_failed`

## Exports

Main package:

- `createExpressPaymentMiddleware`
- `createHonoPaymentMiddleware`
- `createPaymentMiddlewareFoundation`
- `AgentPayError`
- `createConfigurationError`
- related TS types

Subpath export:

- `@zbdpay/agent-pay/next` -> `withPaymentRequired`

## Scripts

```bash
npm run build
npm run test
npm run lint
npm run typecheck
npm run smoke:adapters
npm run example:http-server
npm run release:dry-run
```

## Notes

- Middleware stores verified settled tokens in a local file token store by default.
- For production, set `tokenStorePath` to durable storage if required by your deployment model.
