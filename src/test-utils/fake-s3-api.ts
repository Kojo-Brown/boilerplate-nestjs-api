import { Readable } from "node:stream";
import { createHash } from "node:crypto";

/**
 * An in-process S3, spoken over HTTP.
 *
 * Installed as the SDK's `requestHandler`, so a command sent through
 * `S3StorageAdapter` is really signed, serialised into an HTTP request, and
 * answered with real S3 XML that the SDK's own parser has to make sense of.
 * Stubbing `S3Client.send` would have been a tenth of the code and would have
 * tested the adapter against our idea of the SDK rather than the SDK — every
 * bug this level catches (a missing `x-amz-meta-` prefix, a `MaxKeys` that
 * never reached the query string, an ETag we forgot to quote) is invisible to a
 * stub, because a stub is handed the parsed command.
 *
 * It implements the five operations this adapter uses and nothing else. An
 * unrecognised request is a 501 rather than a silent 200, so a new call added
 * to the adapter fails the contract instead of quietly passing.
 */
export class FakeS3Api {
  private readonly objects = new Map<string, FakeS3Object>();

  /** Every request the handler has answered, for assertions about the wire. */
  readonly requests: FakeS3Request[] = [];

  constructor(readonly bucket: string) {}

  /** Pre-seeds an object without going through the adapter. */
  seed(key: string, body: Buffer, contentType = "application/octet-stream"): void {
    this.objects.set(key, { body, contentType, metadata: {}, lastModified: new Date() });
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  /**
   * The `Cache-Control` the store received, if any.
   *
   * S3 echoes this header back on GET but the SDK surfaces it on an output
   * field nothing in the port reads, so the only way to prove the adapter sent
   * it is to ask the store what arrived.
   */
  cacheControlOf(key: string): string | undefined {
    return this.objects.get(key)?.cacheControl;
  }

  get size(): number {
    return this.objects.size;
  }

  /**
   * The SDK's `RequestHandler` surface.
   *
   * Returned as a plain object rather than a `NodeHttpHandler` subclass: the
   * concrete classes live in `@smithy/*`, which is a transitive dependency this
   * package does not declare, and importing one would be reaching through
   * `node_modules` for a type. The SDK only ever calls these three members.
   */
  get requestHandler(): FakeRequestHandler {
    return {
      handle: (request: FakeHttpRequest) => Promise.resolve({ response: this.answer(request) }),
      updateHttpClientConfig: () => undefined,
      httpHandlerConfigs: () => ({}),
    };
  }

  private answer(request: FakeHttpRequest): FakeHttpResponse {
    const query = request.query ?? {};
    // Path-style addressing: `/{bucket}/{key}`. The adapter forces it whenever
    // `S3_ENDPOINT` is set, which the contract always does.
    const path = decodeURIComponent(request.path).replace(/^\/+/, "");
    const key = path.startsWith(`${this.bucket}/`) ? path.slice(this.bucket.length + 1) : "";

    this.requests.push({ method: request.method, key, query });

    if (!path.startsWith(this.bucket)) {
      return errorResponse(404, "NoSuchBucket", "The specified bucket does not exist");
    }
    if ("list-type" in query) return this.list(query);

    switch (request.method) {
      case "PUT":
        return this.put(key, request);
      case "GET":
        return this.get(key, { withBody: true });
      case "HEAD":
        return this.get(key, { withBody: false });
      case "DELETE":
        return this.delete(key);
      default:
        return errorResponse(
          501,
          "NotImplemented",
          `FakeS3Api does not implement ${request.method}`,
        );
    }
  }

  private put(key: string, request: FakeHttpRequest): FakeHttpResponse {
    const body = toBuffer(request.body);
    const metadata: Record<string, string> = {};

    for (const [header, value] of Object.entries(request.headers)) {
      // The SDK is responsible for the `x-amz-meta-` prefix; asserting on it
      // here is what proves user metadata actually reached the wire.
      if (header.toLowerCase().startsWith("x-amz-meta-")) {
        metadata[header.toLowerCase().slice("x-amz-meta-".length)] = value;
      }
    }

    this.objects.set(key, {
      body,
      contentType: header(request, "content-type") ?? "application/octet-stream",
      cacheControl: header(request, "cache-control"),
      metadata,
      lastModified: new Date(),
    });

    return { statusCode: 200, headers: { etag: etagOf(body) }, body: Readable.from([]) };
  }

  private get(key: string, options: { withBody: boolean }): FakeHttpResponse {
    const object = this.objects.get(key);
    if (!object) {
      // S3 answers HEAD with a bare 404 and no body — there is no XML to parse,
      // which is exactly why the adapter cannot rely on the error code alone.
      return options.withBody
        ? errorResponse(404, "NoSuchKey", "The specified key does not exist.")
        : { statusCode: 404, headers: {}, body: Readable.from([]) };
    }

    const headers: Record<string, string> = {
      etag: etagOf(object.body),
      "content-type": object.contentType,
      "content-length": String(object.body.byteLength),
      "last-modified": object.lastModified.toUTCString(),
      ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
    };
    for (const [name, value] of Object.entries(object.metadata)) {
      headers[`x-amz-meta-${name}`] = value;
    }

    return {
      statusCode: 200,
      headers,
      body: Readable.from(options.withBody ? [object.body] : []),
    };
  }

  private delete(key: string): FakeHttpResponse {
    // Unconditional, like the real DeleteObject: deleting an absent key is a
    // 204, not a 404.
    this.objects.delete(key);
    return { statusCode: 204, headers: {}, body: Readable.from([]) };
  }

  private list(query: Record<string, string>): FakeHttpResponse {
    const prefix = query.prefix ?? "";
    const maxKeys = Number(query["max-keys"] ?? "1000");
    const after = query["continuation-token"];

    const matching = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    const page = matching.slice(0, maxKeys);
    const truncated = matching.length > page.length;

    const contents = page
      .map((key) => {
        const object = this.objects.get(key);
        if (!object) return "";
        return (
          `<Contents><Key>${escapeXml(key)}</Key>` +
          `<LastModified>${object.lastModified.toISOString()}</LastModified>` +
          `<ETag>${escapeXml(etagOf(object.body))}</ETag>` +
          `<Size>${object.body.byteLength}</Size>` +
          `<StorageClass>STANDARD</StorageClass></Contents>`
        );
      })
      .join("");

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Name>${escapeXml(this.bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
      `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
      `<IsTruncated>${truncated}</IsTruncated>` +
      (truncated
        ? `<NextContinuationToken>${escapeXml(page.at(-1) ?? "")}</NextContinuationToken>`
        : "") +
      contents +
      `</ListBucketResult>`;

    return {
      statusCode: 200,
      headers: { "content-type": "application/xml" },
      body: Readable.from([Buffer.from(xml, "utf8")]),
    };
  }
}

/** S3 quotes its ETags, and code that compares them has to see the quotes. */
function etagOf(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function errorResponse(statusCode: number, code: string, message: string): FakeHttpResponse {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`;
  return {
    statusCode,
    headers: { "content-type": "application/xml" },
    body: Readable.from([Buffer.from(xml, "utf8")]),
  };
}

function header(request: FakeHttpRequest, name: string): string | undefined {
  const match = Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

/**
 * Copies, always. A real request serialises the body onto a socket, so the
 * store never shares memory with the caller's buffer — and an adapter that
 * handed S3 a buffer the caller then mutated would look correct here and be
 * wrong against the network.
 */
function toBuffer(body: unknown): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError(`FakeS3Api cannot read a request body of type ${typeof body}`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface FakeS3Object {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly metadata: Record<string, string>;
  readonly lastModified: Date;
}

export interface FakeS3Request {
  readonly method: string;
  readonly key: string;
  readonly query: Record<string, string>;
}

interface FakeHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

interface FakeHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Readable;
}

interface FakeRequestHandler {
  handle(request: FakeHttpRequest): Promise<{ response: FakeHttpResponse }>;
  updateHttpClientConfig(): void;
  httpHandlerConfigs(): Record<string, never>;
}
