# Security headers and CORS

Every response this service sends carries a set of headers that tell a browser
what it may do with it, and a `Access-Control-Allow-Origin` decision that says
which sites may read it at all. Both are configured in
`src/common/security/`, bound by `applySecurity()` from `main.ts` and from
`test/helpers/create-test-app.ts`, and validated at boot by `envSchema`.

The reason this module is as defensive as it is: **none of it fails loudly.** A
wrong value here produces no error in this process. The request succeeds, the
response is correct, and the only party that notices is a browser in somebody
else's tab, which silently drops the response and reports it to a console nobody
is reading. So the rules that can be checked are checked at startup, and the
behaviour that cannot be is covered by tests over a real router.

## What was here before

`main.ts` called:

```ts
app.enableCors({ origin: config.get("ALLOWED_ORIGINS", "*"), credentials: true });
```

That has two defects, and both are the silent kind:

- `ALLOWED_ORIGINS` is a comma-separated list, and it was passed to `cors` as a
  single string. `cors` compares the `Origin` header against that string with
  `===`, so `https://app.example.com,https://admin.example.com` matches no
  origin whatsoever. A list with one entry worked; adding the second broke the
  first, with no error anywhere.
- With the default `*`, the response was `Access-Control-Allow-Origin: *`
  alongside `Access-Control-Allow-Credentials: true`. The Fetch specification
  forbids that pair: a browser discards the response rather than honouring it.
  A credentialed request from any origin therefore failed, and the
  configuration that looked the most permissive was the one that worked least.

## The CORS allowlist

`ALLOWED_ORIGINS` is a comma-separated list of origins, or `*`.

An **origin** is `scheme://host[:port]` — no path, no trailing slash, no
`*.example.com` wildcard. That form is not a style preference: it is exactly
what a browser puts in the `Origin` header, and the comparison is a string
equality. `https://app.example.com/` — what you get by copying out of an address
bar — matches nothing, forever. `refineSecurityEnv` rejects any entry that is
not already a serialised origin, naming the entry, at boot.

Matching is exact. A subdomain of an allowed origin is not allowed, and neither
is the same host on another scheme or port. When an origin matches it is
_reflected_ — `Access-Control-Allow-Origin` takes a single value, so echoing the
whole list would produce a header no browser honours.

A request with **no** `Origin` header — curl, a health probe, a service-to-service
call — is allowed through. CORS is a browser mechanism; refusing those would
break every non-browser client while stopping nothing, since anything that can
omit the header can forge it too.

A request from an origin that is **not** on the list is still executed; what it
does not get is a header naming it, so the browser withholds the response from
the page that asked. The rejection is spelled `callback(null, false)` rather
than `callback(new Error(...))` deliberately: an error would become a 500
through `AllExceptionsFilter`, which lets a page in a stranger's tab fill this
service's error logs and alerting with traffic it chose.

### `*`

`*` means "reflect whatever origin asks", not the literal `*` — see the second
defect above. It is the default, so a clean clone boots with no CORS
configuration, and it is **refused in production while credentials are on**:
that combination is the precise property the same-origin policy exists to deny,
namely that any page a user visits may call this API with their session and read
the answer. A genuinely public, unauthenticated deployment can keep the wildcard
by setting `CORS_ALLOW_CREDENTIALS=false`.

### Headers

`Access-Control-Allow-Headers` is the set of request headers a browser may send:
`Authorization`, `Content-Type`, `Accept`, `If-Match`, `If-None-Match`,
`Idempotency-Key` and `x-correlation-id`. A preflight naming anything outside
that list is refused, so each entry is a feature a browser client can use at all.

`Access-Control-Expose-Headers` is the easier one to get wrong, because omitting
an entry breaks nothing visible: the header arrives and `headers.get(...)`
returns `null`. `ETag`, `Idempotency-Replayed`, `x-correlation-id` and
`Retry-After` are exposed. Without the first, a browser client cannot see the
version it is required to send back in `If-Match` — the optimistic-concurrency
endpoints would be unusable from a browser and perfectly fine from curl.

## Content-Security-Policy

Two policies, chosen per request path.

**API responses** get a refusal rather than an allowlist:

```
default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox
```

A JSON API has no legitimate subresources, so nothing needs to load, execute or
connect. This matters on exactly one kind of day: when a browser has been
persuaded to render a response as HTML — a sniffing bug, a `Content-Type` this
service got wrong, a reflected value in an error body. `X-Content-Type-Options:
nosniff` is the first answer to that; this is the second, because a defence
against script execution should not have a single point of failure. `sandbox`
drops such a response into an opaque origin with scripts and forms disabled.

**The Swagger UI page** at `/docs` is a real HTML document that loads a
stylesheet, three scripts and a favicon, so `default-src 'none'` would leave it
blank. It gets its own policy: `'self'` throughout — `swagger-ui-dist` is served
from this origin, so no CDN is named and `connect-src 'self'` lets **Try it
out** call this API and nothing else.

`'unsafe-inline'` appears once, on `style-src`. The page `@nestjs/swagger`
generates carries two inline `<style>` blocks and Swagger UI writes more at
runtime, which no hash can cover. It is confined to styling: `script-src` stays
`'self'`, which is the directive that decides whether injected markup executes.
`test/security-headers.e2e-spec.ts` checks that against the served page rather
than taking it on trust — every `<script>` it finds must be external and
same-origin.

`/docs-json` and `/docs-yaml` are API responses that happen to live next to the
page, and they take the strict policy like everything else.

Set `CSP_REPORT_URI` to collect violations, and `CSP_REPORT_ONLY=true` to
measure a policy before enforcing it. Report-only is off by default, because a
policy that is only ever observed is not a control. `report-uri` is used rather
than `report-to`: the newer directive needs a matching `Reporting-Endpoints`
header and is still unimplemented in Safari and Firefox, so a policy that used
it alone would hear nothing from most of the browsers a violation comes from.

## HSTS

`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.

The header is a promise: every browser that has seen it refuses to talk to this
host over cleartext for that long, whatever DNS says afterwards. Two years is
what the preload list asks for.

`preload` is a submission, not a request — hstspreload.org reads the live header
and only accepts a host whose `max-age` is at least `31536000` **and** which
sends `includeSubDomains`. Getting _off_ the list takes months. So the
combination is arithmetic the config module does at boot: `HSTS_PRELOAD` with a
shorter `max-age`, or without `includeSubDomains`, is a refused startup rather
than a rejected submission nobody follows up on.

The header is ignored over plain HTTP — a browser only records it from a
response that arrived over TLS — so sending it in development costs nothing.
Terminating TLS at a load balancer does not change where it should come from:
an origin that sends it is one fewer thing to remember when the ingress is
replaced.

## The rest

| Header                              | Value         | Why                                                                                                                                                       |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Content-Type-Options`            | `nosniff`     | Stops a JSON body being re-interpreted as HTML.                                                                                                           |
| `X-Frame-Options`                   | `DENY`        | Alongside `frame-ancestors 'none'`; the one honoured where they disagree is the CSP directive.                                                            |
| `Referrer-Policy`                   | `no-referrer` | `/v1/users/:id` is an identifier, and a JSON response has no navigation that needs a referrer.                                                            |
| `Cross-Origin-Resource-Policy`      | `same-origin` | Blocks a no-CORS embed (`<img src>`, `<script src>`) from another site. Does not affect the CORS `fetch` calls the allowlist governs.                     |
| `Cross-Origin-Opener-Policy`        | `same-origin` | No shared window handle.                                                                                                                                  |
| `Cross-Origin-Embedder-Policy`      | _(not sent)_  | Governs what a document may embed — not a question a JSON API has, and it would stop the docs page loading anything that has not opted in.                |
| `Origin-Agent-Cluster`              | `?1`          | Asks for origin-keyed isolation.                                                                                                                          |
| `X-DNS-Prefetch-Control`            | `off`         | No speculative lookups from an API response.                                                                                                              |
| `X-Download-Options`                | `noopen`      | Legacy IE download handling.                                                                                                                              |
| `X-Permitted-Cross-Domain-Policies` | `none`        | No Flash/Acrobat cross-domain policy file.                                                                                                                |
| `X-XSS-Protection`                  | `0`           | Not a typo. The legacy auditor was itself exploitable and is gone from current browsers; disabling it explicitly stops an old one re-introducing the bug. |
| `X-Powered-By`                      | _(removed)_   | Express's fingerprint only ever helps somebody else.                                                                                                      |

Helmet is configured with `useDefaults: false` and every option written out. A
default that changed in a patch release would otherwise change this service's
behaviour without appearing in any diff, and the headers a security review asks
about should be readable in the file that sets them.

## Ordering

`applySecurity()` runs **before** `app.init()`. Express matches middleware in
registration order and Nest mounts its router during `init()`; anything bound
afterwards sits behind every route and never runs.

The header middleware is registered before `enableCors`, so a preflight that
`cors` answers by itself — it ends the response rather than calling `next()` —
still carries the security headers everything else does.

It is called from `create-test-app.ts` as well as `main.ts`, for the reason the
shared interceptor ordering is: an e2e suite that bound these differently would
be testing an application nobody deploys. With headers that matters more than
usual, because the suite is the only place their absence is observable at all.

## Configuration

| Variable                  | Default    | Meaning                                                                     |
| ------------------------- | ---------- | --------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`         | `*`        | Comma-separated origins, or `*`. Refused in production with credentials on. |
| `CORS_ALLOW_CREDENTIALS`  | `true`     | Whether cross-origin requests may carry cookies and `Authorization`.        |
| `CORS_MAX_AGE_SECONDS`    | `600`      | `Access-Control-Max-Age`. Chromium caps this at 2 hours regardless.         |
| `HSTS_MAX_AGE_SECONDS`    | `63072000` | Two years. Must be ≥ `31536000` while `HSTS_PRELOAD` is on.                 |
| `HSTS_INCLUDE_SUBDOMAINS` | `true`     | Required by the preload list.                                               |
| `HSTS_PRELOAD`            | `true`     | Sends the `preload` token.                                                  |
| `CSP_REPORT_URI`          | _(unset)_  | Where violations are posted.                                                |
| `CSP_REPORT_ONLY`         | `false`    | Report instead of enforce.                                                  |
