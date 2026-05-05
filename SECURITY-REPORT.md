# Stellarise Valuation API — Security Audit Report

**Project:** Stellarise Property Valuation API  
**Repository:** `Arna77/stellarise-valuation`  
**Deployment:** Railway · `valuation.stellarise.io`  
**Stack:** Node.js · Express · Prisma · PostgreSQL  
**Audit Date:** 2026-05-04  
**Auditor:** Internal — Claude Code (Anthropic)  
**Status:** ✅ Remediated

---

## Executive Summary

A security review was conducted against the live Stellarise Valuation API deployed at  
`https://valuation.stellarise.io`. Five issues were identified spanning one **Critical**, three **Medium**, and one **Informational** severity. All findings have been remediated in this commit.

---

## Findings Summary

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| SVA-01 | No rate limiting on valuation endpoint | 🔴 Critical | ✅ Fixed |
| SVA-02 | CORS policy allows all origins | 🟠 Medium | ✅ Fixed |
| SVA-03 | Missing security headers (X-Frame-Options, HSTS, CSP) | 🟠 Medium | ✅ Fixed |
| SVA-04 | Unbounded request body size | 🟡 Low | ✅ Fixed |
| SVA-05 | Server technology disclosed via X-Powered-By header | ℹ️ Info | ✅ Fixed |

---

## Findings Detail

---

### SVA-01 · No Rate Limiting — 🔴 Critical

**Location:** `src/server.js` — `POST /api/valuation/estimate`

**Description:**  
The valuation endpoint had no request rate limiting. An attacker could send thousands of requests per second, exhausting the Railway compute allocation and PostgreSQL connection pool within minutes. Because each valuation request performs multiple database queries (comp pool fetch → similarity scoring), the endpoint was CPU-intensive and therefore a high-value denial-of-service target.

**Reproduction:**
```bash
# 500 requests in ~10 seconds — no throttling observed
for i in $(seq 1 500); do
  curl -s -X POST https://valuation.stellarise.io/api/valuation/estimate \
    -H "Content-Type: application/json" \
    -d '{"propertyType":"condominium","builtUpSqft":1000,"postcode":"50450","state":"Kuala Lumpur"}' &
done
```

**Impact:**  
- Service unavailability for legitimate users  
- Railway usage bill spike  
- Database connection exhaustion  

**Fix Applied:**  
Two rate limiters added via `express-rate-limit`:
- **Global:** 200 requests / 15 minutes per IP  
- **Valuation endpoint:** 30 requests / 15 minutes per IP (stricter, CPU-expensive route)

```js
const valuationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Valuation rate limit reached. Please try again in 15 minutes." },
});
app.use("/api/valuation/estimate", valuationLimiter);
```

---

### SVA-02 · CORS Wildcard Policy — 🟠 Medium

**Location:** `src/server.js` — `app.use(cors())`

**Description:**  
`cors()` with no options sets `Access-Control-Allow-Origin: *`, permitting any website on the internet to make authenticated cross-origin requests to the API. This enables adversarial sites to silently call the valuation API on behalf of any visiting user's browser — leaking request metadata and contributing to abuse quotas.

**Evidence (live response header):**
```
access-control-allow-origin: *
```

**Fix Applied:**  
CORS restricted to an explicit allowlist:
```js
const ALLOWED_ORIGINS = [
  "https://stellarise.io",
  "https://www.stellarise.io",
  "https://valuation.stellarise.io",
  "http://localhost:3001",
  "http://localhost:8888",
  "http://localhost:8899",
];
```
Requests from unlisted origins now receive an HTTP 500 with CORS error rather than a successful response.

---

### SVA-03 · Missing Security Headers — 🟠 Medium

**Location:** `src/server.js` — middleware stack

**Description:**  
The API response headers lacked the following security controls:

| Header | Risk if Missing |
|--------|----------------|
| `Content-Security-Policy` | XSS injection of inline scripts if any HTML is ever served |
| `Strict-Transport-Security` | Browser may downgrade HTTPS→HTTP, enabling MITM |
| `X-Frame-Options: DENY` | Clickjacking — API responses embeddable in iframes |
| `X-Content-Type-Options: nosniff` | MIME-sniffing attacks in older browsers |

**Fix Applied:**  
`helmet` middleware added with explicit configuration:
```js
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], ... } },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: "deny" },
  xPoweredBy: false,
}));
```

**Headers now present on all responses:**
```
content-security-policy: default-src 'self'; ...
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-frame-options: DENY
x-content-type-options: nosniff
```

---

### SVA-04 · Unbounded Request Body — 🟡 Low

**Location:** `src/server.js` — `app.use(express.json())`

**Description:**  
`express.json()` with no `limit` option defaults to **100 kb**. While Express itself enforces this, explicitly setting a tighter limit appropriate for the API's payload profile (a valuation request body is well under 1 kb) is a defence-in-depth measure against memory exhaustion via large JSON payloads.

**Fix Applied:**
```js
app.use(express.json({ limit: "50kb" }));
```

---

### SVA-05 · Server Technology Disclosure — ℹ️ Informational

**Location:** All API responses

**Description:**  
The `X-Powered-By: Express` header was present on every response, advertising the exact server framework version to potential attackers and aiding fingerprinting.

**Evidence:**
```
x-powered-by: Express
```

**Fix Applied:**  
`helmet({ xPoweredBy: false })` removes the header entirely. No `X-Powered-By` header is now emitted.

---

## Tests Passing (Pre-existing)

The following attack vectors were verified as NOT present before this audit:

| Test | Result |
|------|--------|
| SQL Injection (via Prisma parameterised queries) | ✅ Blocked |
| XSS reflection in API response body | ✅ Not reflected |
| Oversized JSON payload (>100 kb) | ✅ Rejected by Express default |

---

## Residual Risks / Recommendations

The following items are outside the scope of this fix commit but are recommended for the roadmap:

| Item | Priority | Notes |
|------|----------|-------|
| API key authentication | Medium | Currently the API is public. Adding a lightweight `x-api-key` header check for the `/estimate` endpoint would prevent abuse by non-Stellarise callers once the product is live. |
| Structured request logging | Medium | Add `morgan` or equivalent. Logs currently go to stdout with no IP or path context, making incident investigation difficult. |
| Input validation library | Low | `express-validator` or `zod` to enforce schema on `POST /api/valuation/estimate` request body before it reaches the engine. |
| Database connection pooling | Low | Railway Postgres free tier has a connection limit of 25. Under high load, the PgBouncer connection pooler should be enabled via Railway add-on. |

---

## Changes Made

**Files modified:**

| File | Change |
|------|--------|
| `src/server.js` | Added `helmet`, `express-rate-limit`, CORS allowlist, 50 kb body limit |
| `package.json` | Added `helmet ^8.0.0` and `express-rate-limit ^7.0.0` dependencies |

**Packages added:**
- `helmet` — security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, X-Powered-By removal)
- `express-rate-limit` — IP-based rate limiting for global and per-route throttling

---

*Report generated 2026-05-04 by Claude Code internal security review.*
