# Storage — the Adapter pattern

`StorageService` stores files through one of three backends, chosen at boot by
`STORAGE_ADAPTER`. Nothing else in `src` imports an adapter class, so switching a
deployment from S3 to a local disk is one environment variable.

```
UsersController ──▶ StorageService ──▶ StorageAdapter (port)
                                          ├── S3StorageAdapter          (also PresigningStorageAdapter)
                                          ├── LocalDiskStorageAdapter
                                          └── InMemoryStorageAdapter
```

## Choosing a backend

| `STORAGE_ADAPTER`  | What it is                       | Survives a restart | Survives a second replica | Presigned URLs |
| ------------------ | -------------------------------- | ------------------ | ------------------------- | -------------- |
| `memory` (default) | a `Map`                          | no                 | no                        | no             |
| `local`            | files under `STORAGE_LOCAL_ROOT` | yes                | **no**                    | no             |
| `s3`               | S3, MinIO, LocalStack, R2        | yes                | yes                       | yes            |

`memory` is the default so a clean clone boots with no storage configuration at
all, exactly as `PAYMENTS_PROVIDER` defaults to `mock`. It is **refused at boot
in production** by `env.schema.ts`. That is deliberately stricter than a warning:
every other misconfiguration in this project produces an error someone can see,
whereas a memory-backed store accepts every upload, serves every download, and
silently loses the files on the next restart. A default that is right in a test
and catastrophic in production has to be unable to reach production.

`local` _is_ allowed in production, because a single node writing to a mounted
volume is a real deployment. `StorageService` logs a warning at boot anyway,
since the failure mode — an object written by one pod is a 404 from another —
appears only once someone scales to two replicas, and should not be discovered
during an incident.

Selecting `s3` without `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` is a boot failure naming the missing variable, not a 503
on the first upload.

## The port

`StorageAdapter` (`src/storage/ports/storage-adapter.port.ts`) is written to
S3's semantics rather than a filesystem's — a flat keyspace with atomic
whole-object writes. That direction is the survivable one: a flat keyspace can
be emulated on a disk, but directory handles, partial writes and rename
semantics cannot be emulated on S3.

Eight members: `put`, `get`, `getStream`, `head`, `exists`, `delete`, `list`,
plus `name` and `isConfigured`.

### Why presigning is a separate interface

`PresigningStorageAdapter extends StorageAdapter` and adds `presignPut` and
`presignGet`. Only `S3StorageAdapter` implements it.

A presigned URL is a signature the _store_ verifies. A disk and a `Map` have
nothing to verify one with, so folding these two methods into the base port
would leave two bad options: every backend grows a method that throws — so no
caller can rely on it and the interface has stopped meaning anything — or the
local backends fabricate a URL that nothing serves. Splitting the interface
(ISP) and testing for the capability with `supportsPresigning()` keeps the base
port honest.

`StorageService.getPresignedPutUrl` / `getPresignedGetUrl` therefore answer
**501 Not Implemented** when the active adapter cannot sign. 501 rather than
503, because no configuration will make a filesystem verify a signature: the
client's remedy is to upload through the API, and a 503 would invite a retry
that can never succeed.

**Not done, and a reasonable follow-up:** the local adapters could issue
HMAC-signed URLs pointing back at our own API, which is how a MinIO-less dev
setup usually keeps the direct-upload flow working. That is a signed public
upload endpoint — signature verification, replay window, body-size enforcement —
rather than an adapter method, so it did not belong in this change.

## Keys

Every key goes through `assertValidObjectKey` before it reaches any backend.
Validating centrally rather than per-adapter is what makes a key exercised
against the in-memory adapter in a test proof of anything about production: `../`
is an ordinary character sequence in a flat keyspace and a directory escape on a
disk, and an adapter that defended only itself would let the safe backend certify
behaviour the dangerous one cannot survive.

A key must:

- be 1–1024 bytes of UTF-8 (S3's limit, measured in bytes, not characters)
- have every `/`-separated segment at most 255 bytes — **the filesystem's limit,
  not S3's.** S3 would take a single 1024-byte segment; every mainstream
  filesystem answers `ENAMETOOLONG`. Applying the stricter of the two everywhere
  is what keeps the backends interchangeable
- contain no control characters (a NUL truncates a C path, so `a\0/../../etc/passwd`
  would be written to a path a naive parser approved as `a`)
- contain no backslash (a separator on Windows, an ordinary character in S3)
- not start with `/`, not end with `/`, and contain no empty, `.` or `..` segment
- have no leading or trailing spaces in any segment (legal in S3, invisible in a
  log, and an excellent source of unreproducible bug reports)
- not start with a drive letter

`LocalDiskStorageAdapter` re-checks the resolved path against its root anyway.
Two independent checks is deliberate: the first is a parser, and a parser that is
wrong about one encoding should not be the only thing between a request and
`/etc/passwd`.

User metadata is normalised the same way — keys lower-cased (S3 returns them
that way), values restricted to printable ASCII (they travel as HTTP headers),
and the whole set capped at S3's 2 KB.

## How the local adapter stores things

Every key becomes a **directory** holding two files:

```
<root>/avatars/user-1/photo.jpg/.object      the bytes
<root>/avatars/user-1/photo.jpg/.meta.json   content type, user metadata, etag
```

The obvious layout — key `a/b` at `<root>/a/b` — cannot represent a flat
keyspace. S3 lets `a/b` and `a/b/c` both be objects; a filesystem needs `a/b` to
be a file for one and a directory for the other. `avatars/<id>` alongside
`avatars/<id>/thumb` is an ordinary pair of keys, and under the obvious layout
the second upload fails with `ENOTDIR` against the disk and succeeds against S3.
A directory per key removes the conflict, and removes a second hazard for free:
with a `<key>.meta.json` sidecar, uploading the key `a.meta.json` would have
silently rewritten the content type of the object `a`.

Two further gaps a filesystem leaves, and how each is bridged:

- **Metadata** has nowhere to live. Extended attributes are the tempting answer
  and are not portable — unavailable on many container filesystems, silently
  dropped by `docker cp` and most archive formats. Hence the JSON sidecar. A
  missing or unparseable sidecar degrades to `application/octet-stream` rather
  than making the object unreadable: losing the content type is bad, losing the
  file is worse. That is what lets the adapter read a restored backup or a
  seeded fixture it did not write.
- **Atomic replacement.** `writeFile` truncates first, so a concurrent reader can
  see a half-written object and a crash mid-write leaves one permanently. Every
  write goes to a temporary file in the same directory and is `rename`d into
  place. The sidecar is written _before_ the rename, so a body never exists
  without its metadata.

Deleting an object prunes the empty directories it leaves behind, stopping at the
root or at the first directory that still holds something.

## Testing

`storage-adapter.contract.ts` is one behavioural contract, run by
`storage-adapter.contract.spec.ts` against all three backends. Adding an adapter
is one `describeStorageAdapterContract` call.

The type system checks eight signatures; what actually breaks an upload is
behaviour. The contract is what caught, during this change, that the in-memory
adapter threw _synchronously_ where the other two rejected — a caller using
`.catch()` would have crashed against that backend alone.

Each backend is driven at its real level:

- **in-memory** — directly.
- **local** — against a real temporary directory. Mocking `fs` would leave
  rename atomicity, `ENOTDIR` and directory nesting untested, which are exactly
  the parts that differ from the other two.
- **s3** — against `FakeS3Api` (`src/test-utils/fake-s3-api.ts`), an in-process
  S3 spoken over HTTP and installed as the SDK's `requestHandler`. Commands are
  really signed, serialised and answered with real S3 XML that the SDK's own
  parser has to read. Stubbing `S3Client.send` would have been a tenth of the
  code and would have tested the adapter against our idea of the SDK rather than
  the SDK: a missing `x-amz-meta-` prefix, a `MaxKeys` that never reached the
  query string, or an unquoted ETag are all invisible to a stub, because a stub
  is handed the parsed command.

The fake reaches the adapter through `S3_CLIENT_OPTIONS`, the same optional DI
token an operator would use to tune retries or timeouts — so there is no
test-only branch in the adapter for the fake to take.

## Adding a backend

1. Implement `StorageAdapter` (and `PresigningStorageAdapter` if the store can
   sign) in `src/storage/adapters/`.
2. Add its name to `STORAGE_ADAPTER_NAMES` in the port. `env.schema.ts` picks it
   up from there, so the enum and the adapter list cannot drift.
3. Register it in `storage.module.ts` — the class in `providers`, the class in
   `inject`.
4. Add one `describeStorageAdapterContract` line to the contract spec.
5. Add its credentials to `requiredEnvFor` in `storage.service.ts` so a
   misconfigured deployment names the right variable.

Neither `StorageService` nor any consumer changes (OCP).

## Security notes

- **Presigned uploads sign the content type**, not just the host. The SDK signs
  `host` alone by default, which would make `ContentType` a suggestion: a client
  handed a URL for `image/jpeg` could upload `text/html` to the same key, and the
  bucket would then serve attacker-controlled HTML from its own origin.
- **Keys are validated before signing.** A signed URL for `../../etc/passwd` is
  meaningless against S3 but a real escape against a store that maps keys to
  paths.
- **No credential ever reaches a key or a log line.** `StorageOperationError`
  carries the backend's own error code for correlation, never its configuration.
