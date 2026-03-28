# Engineering Contract — `@axobot/pay`

> **Status**: Normative. All implementation work in this repository must conform to every rule in this document.
> **Scope**: Server-side L402 middleware for Express, Next.js, and Hono. Issues 402 challenges via ZBD, verifies macaroon/preimage proofs, and gates handler execution behind confirmed Lightning payments.

---

## 1. Auth Header

### 1.1 ZBD API Authentication (outbound)

All outbound calls from this middleware to `api.zbdpay.com` MUST include the operator's API key in the `apikey` HTTP header (lowercase).

```
apikey: <ZBD_API_KEY>
```

The key is read from the `ZBD_API_KEY` environment variable. If the variable is absent at middleware initialization, the middleware MUST throw a `configuration_error` and refuse to mount. The raw key MUST NOT appear in any log output, error response, or HTTP header sent to clients.

### 1.2 WWW-Authenticate Challenge Header (outbound to clients)

When a request arrives without a valid `Authorization` header, the middleware MUST respond with HTTP 402 and include the `WWW-Authenticate` header using the `L402` scheme as specified in bLIP-26:

```
WWW-Authenticate: L402 macaroon="<macaroon>", invoice="<bolt11-invoice>"
```

The response body MUST also include the challenge as JSON for clients that parse the body rather than the header:

```json
{
  "macaroon": "<macaroon>",
  "invoice": "<bolt11-invoice>",
  "paymentHash": "<hash>",
  "amountSats": 100,
  "expiresAt": 1234567890
}
```

The `amountSats` field in the body MUST be in satoshis (see Section 2).

### 1.3 Authorization Header Parsing (inbound from clients)

The middleware MUST parse the `Authorization` header for both schemes:

- `L402 <macaroon>:<preimage>` (preferred)
- `LSAT <macaroon>:<preimage>` (legacy compat)

Scheme detection is case-insensitive. A request carrying either scheme with a valid macaroon and matching preimage MUST be admitted. Rejecting a valid `LSAT` credential is a compatibility violation.

### 1.4 Macaroon Binding

Each macaroon MUST be an HMAC token binding the following fields at issuance time:

- Charge ID (from ZBD `POST /v0/charges` response)
- Endpoint path
- Amount in satoshis
- Expiry timestamp

Verification MUST check all four fields. A macaroon issued for one endpoint MUST NOT be accepted on a different endpoint (`resource_mismatch`). A macaroon issued for one price MUST NOT be accepted if the current dynamic price differs (`amount_mismatch`).

---

## 2. Amount Units

### 2.1 Internal Representation

All monetary amounts are stored and processed internally in **millisatoshis (msat)**. The ZBD API returns and accepts msat values on charge and payment endpoints.

```
1 sat = 1000 msat
```

### 2.2 Boundary Outputs

All public API surfaces of this middleware — `PaymentConfig` fields, response body fields, error payloads, and log output — MUST express amounts in **satoshis (sat)**, not msat.

```typescript
// Correct: PaymentConfig amount in sats
type PaymentConfig = {
  amount: number | ((req: Request) => number)  // satoshis
  currency?: 'SAT' | 'USD'
}

// Correct: 402 body in sats
{ "amountSats": 100 }

// Forbidden: msat at any public boundary
{ "amountMsat": 100000 }  // NEVER
```

### 2.3 Conversion Rule

When the ZBD API returns an msat value (e.g., from `GET /v0/btcusd` for USD conversion), the middleware MUST convert to satoshis before using the value in any macaroon binding or response body. Fractional satoshis MUST be rounded down (floor).

```typescript
const amountSats = Math.floor(amountMsat / 1000)
```

### 2.4 USD Pricing

When `currency: 'USD'` is set, the middleware calls `GET /v0/btcusd` to get the live BTC/USD rate, converts the USD cent amount to satoshis, and uses that sat value for invoice creation and macaroon binding. The sat value is recalculated at both invoice creation time and token verification time. A price mismatch between the two calculations MUST return `amount_mismatch`.

### 2.5 LNURL Amount Parameter

The LNURL-pay callback receives amounts in msat (e.g., `?amount=1000000` for 1000 sats). The middleware MUST convert this to sats before comparison with the configured price.

---

## 3. Release Policy

### 3.1 Versioning

This package follows **Semantic Versioning 2.0.0** (semver). Version increments are determined automatically by `semantic-release` based on Conventional Commits in the default branch.

| Commit prefix | Version bump |
|---|---|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or `BREAKING CHANGE:` footer | major |

### 3.2 Publishing

Releases are published to the public npm registry under the `@zbdpay` scope. Publishing uses **npm OIDC Trusted Publishing** via GitHub Actions — no long-lived npm tokens are stored in repository secrets. The workflow exchanges a short-lived GitHub OIDC token for a scoped npm publish token at release time.

The npm package provenance attestation (`--provenance` flag) MUST be enabled on every publish run.

### 3.3 Sub-path Exports

The package exposes framework-specific entry points:

- `@axobot/pay` — Express / Hono middleware
- `@axobot/pay/next` — Next.js App Router handler wrapper

Both entry points are declared in `package.json` `exports`. Adding a new entry point is a minor version change. Removing or renaming an existing entry point is a major version change.

### 3.4 Release Branch

The `main` branch is the only release branch.

### 3.5 Changelog

`semantic-release` generates `CHANGELOG.md` automatically. Manual edits are forbidden.

### 3.6 No Manual Publishes

Publishing by running `npm publish` locally is forbidden.

---

## 4. Compatibility Policy

### 4.1 L402 / bLIP-26

This middleware targets full compliance with the bLIP-26 L402 specification. Any L402-compatible client — ZBD `agent-fetch`, moneydevkit, Lightning Labs `lnget`, or raw curl — MUST be able to complete the payment flow without configuration changes.

The middleware MUST NOT require clients to use ZBD-specific extensions. The only ZBD dependency is on the server side (invoice creation and payment verification).

### 4.2 LSAT Legacy Compatibility

The middleware MUST accept `Authorization: LSAT <macaroon>:<preimage>` in addition to the `L402` scheme. Clients that have not yet migrated to `L402` MUST continue to work.

### 4.3 Error Code Stability

The following error codes are part of the public contract and MUST NOT be renamed or removed within a major version:

| HTTP Status | Code | Condition |
|---|---|---|
| 402 | `payment_required` | No valid token present |
| 401 | `invalid_credential` | Macaroon malformed or bad signature |
| 401 | `invalid_payment_proof` | Preimage does not match payment hash |
| 403 | `resource_mismatch` | Token issued for a different endpoint |
| 403 | `amount_mismatch` | Token issued for a different price |
| 403 | `token_expired` | Token past expiry window |
| 500 | `configuration_error` | `ZBD_API_KEY` not set |
| 500 | `pricing_error` | Dynamic pricing function threw |
| 502 | `invoice_creation_failed` | ZBD charge creation failed |

### 4.4 Token Store

Verified payment tokens are persisted to a local JSON file (default: `~/.zbd-wallet/server-tokens.json`, configurable via `tokenStorePath`). The file schema is stable within a major version. Any change that invalidates existing token files requires a major version bump.

### 4.5 Async Payment Verification

ZBD payment confirmation is asynchronous. The middleware MUST NOT assume the preimage is valid without verifying it against the payment hash from the original charge. Verification uses `GET /v0/charges/:id` to confirm the charge is settled before admitting the request.

### 4.6 ZBD API Version

This middleware targets the `v0` ZBD API surface. A `v1` migration requires a new major version of this package.

### 4.7 Node.js Runtime

Minimum supported runtime: **Node.js 22 LTS**.

---

*Last updated: 2026-02-25. Maintained by the ZBD agent suite team.*
