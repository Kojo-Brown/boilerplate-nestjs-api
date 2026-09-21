# Mutual TLS for service-to-service calls

Ordinary TLS authenticates one end of a connection: the client learns that it is
talking to the server named in the certificate, and the server learns nothing at
all about the client. Every internal API compensates for that somewhere else —
a shared secret in a header, an allowlist of source IPs, a token minted by
whatever the caller could reach. Mutual TLS moves the question down to the
handshake: the client presents a certificate too, the server verifies it against
a trust anchor, and the caller's identity is a property of the connection rather
than of something it typed into a header.

This module is the whole of that for this service: the material it presents, the
peers it accepts, the peers it calls, and what happens when any of it is
replaced. It is off by default — `MTLS_ENABLED=false` — and a clean clone boots
on plain HTTP exactly as before.

## When to turn it on

Three deployments, and only the third wants this on:

1. **Behind a load balancer that terminates TLS.** The certificate the world
   sees is the balancer's. Leave it off.
2. **In a mesh with a sidecar.** Envoy (or Linkerd) terminates mTLS and hands
   the application plaintext on loopback. Leave it off — and know that the
   sidecar is doing exactly what this module does, with the same trade-offs.
3. **The service is its own TLS endpoint.** No sidecar, no terminating proxy,
   and the peers are other services in the same trust domain. That is this.

## Configuration

| Variable                            | Default               | What it does                                                                                   |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `MTLS_ENABLED`                      | `false`               | Terminate mutual TLS in this process.                                                          |
| `MTLS_CERT_FILE`                    | —                     | PEM leaf, optionally followed by its intermediates.                                            |
| `MTLS_KEY_FILE`                     | —                     | PEM private key for the leaf.                                                                  |
| `MTLS_CA_FILE`                      | —                     | PEM trust anchors. Used in both directions.                                                    |
| `MTLS_KEY_PASSPHRASE`               | —                     | Decrypts an encrypted key. A credential: it belongs in the secret store, never beside the key. |
| `MTLS_RELOAD_INTERVAL_MS`           | `300000`              | How often the files are re-read. `0` disables reloading.                                       |
| `MTLS_EXPIRY_WARNING_DAYS`          | `14`                  | Start warning this many days before the material expires.                                      |
| `MTLS_ALLOWED_CLIENTS`              | `*`                   | Identities that may call this service. Refused as `*` in production.                           |
| `MTLS_EXEMPT_PREFIXES`              | `/v1/health,/metrics` | Paths reachable without a client certificate.                                                  |
| `MTLS_ALLOW_UNAUTHENTICATED_PROBES` | `false`               | Accept unauthenticated connections and refuse them at the request instead.                     |
| `MTLS_PEERS`                        | —                     | `origin=identity` pairs this service calls over mutual TLS.                                    |

All of them are declared once, in `src/common/mtls/mtls.env.ts`, spread into
`envSchema` and read a second time straight from `process.env` by `main.ts` —
which has to build the TLS options before `NestFactory.create`, and therefore
before there is a `ConfigService` to ask. The cross-field rules
(`collectMtlsIssues`) are shared by both parses, so the two cannot disagree
about what a valid identity is.

## Identity is a SAN, never a CN

A peer's identity is a `URI:` or `DNS:` entry in the subject alternative name
extension — a SPIFFE id (`spiffe://cluster.local/ns/prod/sa/web`) in a mesh, a
hostname otherwise. Never the subject common name: a CN is free text that no
issuer constrains, while the name constraints a CA uses to limit what it will
vouch for apply to the SAN. Every profile that still mentions a CN for
identification has deprecated it (RFC 6125 §6.4.4, the CA/Browser Forum baseline
requirements).

Reading that extension is less obvious than it looks, and `parseSubjectAltName`
is careful for a reason. The value is attacker-influenced — it is whatever the
peer asked its CA to sign — and Node renders the extension as one string. Where
a value would be ambiguous, Node quotes it as a JSON string literal, so a
certificate carrying

```
DNS:evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders
```

as a **single** DNS name comes back as

```
DNS:"evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders"
```

A parser that splits on `", "` and strips quotes reads that as two entries and
hands the allowlist the identity of a service whose key the peer does not have.
The parser here scans quoted values whole and `JSON.parse`s them, and refuses a
string it cannot frame rather than returning what it understood so far — a SAN
we cannot read is a peer we cannot identify. `peer-identity.spec.ts` runs that
case against a certificate OpenSSL really issued.

## Inbound: who gets in

`main.ts` builds the listener's TLS options from the loaded material:

- **`requestCert: true`**, always. Without it the server never asks for a client
  certificate and every peer is anonymous no matter what the guard does.
- **`rejectUnauthorized`** is `true` unless `MTLS_ALLOW_UNAUTHENTICATED_PROBES`
  is set. True means OpenSSL ends the handshake itself for a peer whose chain
  does not verify: the cheapest possible refusal, and one no bug further up can
  undo.
- **`minVersion: TLSv1.2`**. 1.3 is better and is a one-line change for a
  deployment where every peer can do it; 1.2 is the floor every stack in service
  today clears, and in 1.3 the client certificate arrives after the server's
  Finished message, which changes when a rejection is observed.

Authentication ends there. **Authorisation** is `MtlsPeerGuard`, bound globally
by `MtlsModule` and a pass-through when mTLS is off. The two are genuinely
different questions: a trust anchor answers "is this a workload in our trust
domain", and in a mesh the CA has issued a certificate to everything — the batch
job, the next team's service, a developer's laptop. `MTLS_ALLOWED_CLIENTS` is
the answer to "and does _that_ workload call me", which is why `*` is refused in
production.

The guard is a guard rather than middleware because a `ForbiddenException` from
here goes through `AllExceptionsFilter`: the caller gets this API's error
envelope with its correlation id, like every other refusal. Express middleware
bound with `app.use` runs before Nest's router, so an error it raises reaches
Express's default handler instead — an HTML page, a 500, no correlation id.

### The probe trade-off

A kubelet has no workload identity and cannot be given one, so with
`rejectUnauthorized: true` a liveness probe cannot complete a handshake and the
pod never goes ready. `MTLS_ALLOW_UNAUTHENTICATED_PROBES=true` accepts
unauthenticated connections and moves every refusal into the guard, which then
serves `MTLS_EXEMPT_PREFIXES` and refuses everything else with a 403.

That is a real weakening — an unauthenticated peer now reaches the TLS stack,
the HTTP parser and the router before being refused — and it is opt-in for that
reason. Which side is right depends on whether anything but the kubelet can
reach the port. The exempt paths are already unauthenticated either way (see
`docs/telemetry.md` for `/metrics`), so nothing that was protected by something
else is exempted here.

## Outbound: who we call

`fetch` has no per-request TLS options — the client certificate lives on the
dispatcher — so talking to an internal peer with a certificate and to Stripe
without one means two dispatchers. `MtlsDispatcherRegistry` builds one undici
`Agent` per origin in `MTLS_PEERS`, and `ResilientHttpClient` asks it for one
per call:

```
MTLS_PEERS=https://orders.internal:8443=spiffe://cluster.local/ns/prod/sa/orders
```

An origin that is not listed gets no dispatcher, which is the global one: a
private CA has nothing to say about `api.stripe.com`, and pinning our anchors
for every outbound call would break every third-party integration at once.

Each agent's `checkServerIdentity` requires the server's certificate to carry
the identity named for that origin. For a `DNS:` identity the default hostname
check runs as well. For a SPIFFE id it does not, and that is not a weakening: a
SPIFFE leaf carries a URI SAN and no DNS SAN at all, so
`tls.checkServerIdentity` fails every one of them — while the URI has to match
exactly, which is a stronger statement than the hostname and the one the mesh
actually issues certificates about.

## Loading: what is checked, and why it is checked here

`loadKeyMaterial` refuses to hand back material that would fail later:

- **The files are readable**, and the error names the path. In a mesh that path
  is a mounted secret, and "the volume is not mounted" and "the certificate is
  wrong" are different problems.
- **The certificate file holds a certificate.** An empty file left by an
  interrupted rotation looks exactly like this.
- **The key matches the certificate**, proved by building the secure context
  OpenSSL will build anyway. Otherwise the first evidence is
  `ERR_SSL_KEY_VALUES_MISMATCH` thrown from inside `https.createServer` at the
  first connection.
- **The certificate is inside its validity window.** An expired one would be
  rejected by every peer; refusing it at startup is cheaper than finding it in
  four services' logs at once. A `notBefore` in the future is usually an
  unsynchronised clock.
- **The leaf chains to an anchor in the bundle**, following any intermediates in
  the certificate file. This is the check that catches a leaf rotated without
  its trust bundle, whose only handshake-time evidence is an "unknown CA" alert
  in the _caller's_ logs, naming neither file.

**One trust domain is assumed.** The CA that issued this service's certificate
is the one its peers are verified against — a single `MTLS_CA_FILE` in both
directions — and material whose leaf does not chain to its own bundle is
refused at load. That assumption holds in every mesh and in most private-CA
deployments, and it is what makes the chain check above possible at all. A
deployment that presents a certificate from one CA and trusts a different one
for peers needs a second bundle and a change here; today the workaround is a
bundle containing both anchors.

## Rotation notes

A certificate is the one input to a running service that is guaranteed to stop
working. Everything else fails when something changes; this fails when nothing
does. So rotation is not a feature bolted on here — it is the reason the
material lives behind a service instead of in a `const`.

**The files are polled, not watched.** `fs.watch` on the certificate path is the
obvious implementation and it does not work where this runs: Kubernetes updates
a mounted secret by writing a new timestamped directory and swapping the
`..data` symlink, so the file the watch is holding is never written to and no
event arrives — and the inode it points at still has the old certificate.
Re-reading the path is what sees the swap. The cost is three small file reads
every `MTLS_RELOAD_INTERVAL_MS`, against material that changes hourly at the
very most.

**A failed reload keeps the material in use.** The certificate and the key are
not written atomically together; there is a window — short in a mesh, long in a
hand-run `scp` — where one is new and the other is not. Loading that pair fails,
and swapping it in would turn a rotation into an outage while what we are
holding still works. The reload logs an error, keeps the old material, and tries
again on the next tick.

**A rotation reaches the next connection, not the current ones.**
`server.setSecureContext()` replaces the key, certificate and anchors for
handshakes from that moment on. Connections already established keep the context
they negotiated, which is correct — the peer verified the certificate it was
shown when it was shown it, and nothing about that becomes false when a newer
one is issued. The consequence is that **a revocation is not complete until
those connections end**: after rotating away from a compromised key, drain the
listener (a rolling restart, or closing idle connections and letting the rest
finish) rather than assuming the swap was enough.

**Outbound dispatchers are rebuilt and closed gracefully.** The client
certificate lives on the agent, so a rotated agent is a new agent; the old one
is `close()`d, not `destroy()`ed. Closing stops new requests and resolves once
the ones already on the wire finish — destroying would abort them for no
benefit, since a request in flight was authenticated with material that was
valid when it was sent.

**What cannot be hot-swapped.** `requestCert` and `rejectUnauthorized` belong to
the server, not to the secure context, and so does the listening port. Changing
either needs a new listener — that is a deployment, not a reload.

### Rotating a leaf

1. Write the new certificate and key over the mounted paths (a secret update
   does this for you).
2. Within `MTLS_RELOAD_INTERVAL_MS` the reload picks both up, logs
   `mTLS material rotated`, hands the server a new secure context and rebuilds
   the outbound dispatchers.
3. Nothing restarts. If the pair was half-written, step 2 logs an error and
   retries on the next tick.

### Rotating a CA

Three steps, in this order, and the middle one takes as long as it takes:

1. **Distribute a bundle containing both anchors** to every service, old and
   new. Everyone now trusts certificates from either CA while still presenting
   their old ones. A reload is enough — `key-material.ts` fingerprints the
   anchors as well as the leaf, so a bundle that gained a certificate is a
   rotation rather than a no-op.
2. **Reissue leaves from the new CA**, service by service, at whatever pace the
   fleet allows. Each one is an ordinary leaf rotation.
3. **Remove the old anchor** from the bundle, once nothing is presenting a
   certificate it signed. Until this step the old CA can still authenticate a
   peer, which is exactly why it is a step rather than an afterthought.

Doing 2 before 1 is the outage: a service presenting a certificate nobody trusts
yet.

### Expiry

`MTLS_EXPIRY_WARNING_DAYS` warns on every reload once the material is inside the
window, and the number it counts down to is the earliest expiry in the whole set
— the anchors included. A CA outliving nothing is the failure that arrives
without warning: every leaf it issued stays valid, every handshake starts
failing on the same afternoon, and no leaf's expiry date says anything about it.

## Not done

- **No revocation checking.** No CRL, no OCSP, no OCSP stapling. A certificate
  that has been revoked but not expired is still accepted; the answer here is
  short-lived certificates and the CA rotation above, which is what a mesh
  assumes too.
- **No SPIFFE Workload API.** Material comes from files. A real SPIFFE
  deployment fetches an SVID over a Unix socket and gets rotation pushed to it
  rather than polling for it.
- **One policy for the whole service.** `MTLS_ALLOWED_CLIENTS` is not per route
  or per method, so "orders may write, reporting may only read" is not
  expressible here — that is authorisation at a level this guard does not see.
- **The peer identity is not propagated.** It is checked and logged on a
  refusal, and no handler receives it: there is no `@PeerIdentity()` decorator
  and the access log does not carry it.
- **Only HTTP.** The connections this service makes to Postgres, Redis and Kafka
  are configured elsewhere and are not covered by any of this.
- **WebSocket upgrades are not separately authorised.** The gateway shares the
  TLS listener, so the connection was authenticated in the same handshake, but
  the guard makes no decision for a non-HTTP context.
- **No session-ticket key rotation.** Node's defaults apply.
