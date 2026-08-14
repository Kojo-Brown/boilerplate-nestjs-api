import { BadRequestException } from "@nestjs/common";

/**
 * A single entity-tag as it appeared in an `If-Match` field.
 *
 * `opaque` is the text between the quotes, exactly as sent. `version` is that
 * text read back as a resource version, or `null` when it is not one — a tag
 * this server never issued, or one issued by an earlier validator scheme. That
 * distinction is deliberate: a tag we cannot interpret is still *syntactically*
 * valid, so it must fail the precondition (412) rather than the parse (400).
 */
export interface ParsedEntityTag {
  /** `true` for `W/"..."`. Weak tags can never satisfy `If-Match`; see {@link isSatisfiedBy}. */
  readonly weak: boolean;
  readonly opaque: string;
  readonly version: number | null;
}

/**
 * What a request said about the version it expects to be modifying.
 *
 * `unconditional` is the absence of `If-Match` — the caller has made no claim,
 * so nothing can be checked. `any` is `If-Match: *`, which asserts only that
 * the resource exists. `list` is one or more entity-tags, any one of which
 * satisfying the current version is enough (RFC 9110 §13.1.1).
 */
export type ExpectedVersion =
  | { readonly mode: "unconditional" }
  | { readonly mode: "any" }
  | { readonly mode: "list"; readonly tags: readonly ParsedEntityTag[] };

/** The `If-Match` a caller who sent no header made: none. */
export const UNCONDITIONAL: ExpectedVersion = { mode: "unconditional" };

export const IF_MATCH_HEADER = "if-match";
export const ETAG_HEADER = "ETag";

/** Only non-negative decimal integers, with no leading zeros, are our validators. */
const VERSION_PATTERN = /^(?:0|[1-9]\d*)$/;

/**
 * The validator for a resource at `version`.
 *
 * A *strong* tag, and derived from the version rather than from the response
 * bytes. Hashing the bytes would be the obvious alternative and is wrong here:
 * every response carries a `meta.timestamp` from `ResponseEnvelopeInterceptor`,
 * so a body digest changes on every request and would make `If-Match` fail
 * against a resource nobody touched. The version changes when — and only when —
 * the stored row changes, which is what a validator is supposed to track.
 */
export function formatEntityTag(version: number): string {
  return `"${version}"`;
}

/**
 * Parses an `If-Match` field value.
 *
 * Throws `BadRequestException` for anything that is not a well-formed
 * `If-Match` per RFC 9110 §13.1.1 (`"*" / #entity-tag`). A well-formed field
 * whose tags simply do not match is *not* an error here — that is a failed
 * precondition, and the caller decides the status.
 */
export function parseIfMatch(raw: string): ExpectedVersion {
  const value = raw.trim();

  if (value === "") {
    throw new BadRequestException("If-Match must not be empty");
  }
  if (value === "*") {
    return { mode: "any" };
  }

  return { mode: "list", tags: parseEntityTagList(value) };
}

/**
 * Splits an entity-tag list without splitting on commas *inside* a tag.
 *
 * `,` is a legal `etagc`, so `"a,b"` is one tag and not two. A plain
 * `value.split(",")` would silently turn it into two unmatchable halves, which
 * is a 412 for a request that should have succeeded — so this scans instead.
 */
function parseEntityTagList(value: string): ParsedEntityTag[] {
  const tags: ParsedEntityTag[] = [];
  let index = 0;

  for (;;) {
    index = skipWhitespace(value, index);

    let weak = false;
    if (value.startsWith("W/", index)) {
      weak = true;
      index += 2;
    }

    if (value[index] !== '"') {
      throw new BadRequestException(
        'If-Match must be "*" or a comma-separated list of quoted entity-tags',
      );
    }
    index += 1;

    const close = value.indexOf('"', index);
    if (close === -1) {
      throw new BadRequestException("If-Match contains an unterminated entity-tag");
    }

    const opaque = value.slice(index, close);
    tags.push({ weak, opaque, version: readVersion(opaque) });
    index = skipWhitespace(value, close + 1);

    if (index >= value.length) return tags;
    if (value[index] !== ",") {
      throw new BadRequestException("If-Match entity-tags must be separated by commas");
    }
    index += 1;
  }
}

function skipWhitespace(value: string, from: number): number {
  let index = from;
  while (index < value.length && (value[index] === " " || value[index] === "\t")) index += 1;
  return index;
}

function readVersion(opaque: string): number | null {
  if (!VERSION_PATTERN.test(opaque)) return null;
  const parsed = Number(opaque);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Whether a resource currently at `actual` satisfies what the request expected.
 *
 * Weak tags never match. RFC 9110 §8.8.3.2 forbids sending one in `If-Match`
 * and §13.1.1 requires the *strong* comparison function, under which a weak tag
 * is equivalent to nothing at all — so `W/"3"` fails against version 3. It
 * fails as a precondition rather than as a parse error so that the response is
 * the 412 the comparison rule dictates; {@link describeMismatch} then says the
 * weakness was the reason, which a bare 412 would not.
 */
export function isSatisfiedBy(expected: ExpectedVersion, actual: number): boolean {
  switch (expected.mode) {
    case "unconditional":
      return true;
    // `*` asserts only that a representation exists. Callers reach this having
    // already established that, so there is nothing further to compare.
    case "any":
      return true;
    case "list":
      return expected.tags.some((tag) => !tag.weak && tag.version === actual);
  }
}

/** A message naming why the precondition failed, for the 412 body. */
export function describeMismatch(expected: ExpectedVersion, actual: number): string {
  const current = `the resource is now at ${formatEntityTag(actual)}`;

  if (expected.mode !== "list") {
    return `If-Match precondition failed — ${current}`;
  }

  if (expected.tags.every((tag) => tag.weak)) {
    return `If-Match precondition failed — a weak entity-tag never matches under the strong comparison If-Match requires, and ${current}`;
  }

  const sent = expected.tags.map((tag) => `${tag.weak ? "W/" : ""}"${tag.opaque}"`).join(", ");
  return `If-Match precondition failed — sent ${sent}, but ${current}`;
}
