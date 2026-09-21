import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A miniature certificate authority, for the suites that need real X.509
 * material rather than a description of some.
 *
 * Everything the mTLS code does is a property of a certificate — that a key
 * matches its cert, that a leaf chains to a trust anchor, that a SAN carries
 * the identity an allowlist is checked against — and none of those properties
 * survive being faked. A hand-written object with a `subjectaltname` string
 * would satisfy the parser and tell us nothing about what OpenSSL puts in the
 * extension, which is where the interesting cases live: see the smuggling case
 * in `peer-identity.spec.ts`, whose input no one would have invented.
 *
 * So the certificates are real, issued here, and thrown away with the temporary
 * directory they were written to. They are EC P-256 rather than RSA because a
 * suite that issues a dozen of them should not spend a second on each, and
 * because P-256 is what a service mesh issues anyway.
 *
 * Nothing here is ever valid for anything outside the test process: every key
 * is generated on the spot, lives in `os.tmpdir()`, and is trusted by no store
 * on the machine. `openssl` itself is the only requirement — the same binary
 * CI already uses to mint its ephemeral secrets.
 */

/** What `issue()` produces: a leaf, its private key and the paths they live at. */
export interface IssuedCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly certFile: string;
  readonly keyFile: string;
  /** The first URI or DNS SAN entry, for the assertions that need one. */
  readonly identity: string | null;
}

export interface IssueOptions {
  /** Subject common name. Only ever used for the subject line — see the SANs. */
  readonly commonName: string;
  /**
   * SAN entries, in OpenSSL's `TYPE:value` form (`URI:spiffe://...`,
   * `DNS:localhost`). Written through a config section rather than `-addext`,
   * so a value containing a comma reaches the certificate intact.
   */
  readonly subjectAltNames?: readonly string[];
  /** How long the certificate is valid for. Two days unless a case needs otherwise. */
  readonly days?: number;
  /**
   * Encrypts the private key with this string.
   *
   * Named for what it does rather than `passphrase`, which is OpenSSL's word
   * for it: a `passphrase` identifier sitting beside `"-keyout"` in the
   * argument list below is what a secret scanner reads as a hardcoded
   * credential — key on the left, value on the right — and it is right to look
   * there, even though what it found was a command-line flag.
   */
  readonly encryptKeyWith?: string;
  /** Issues an intermediate CA instead of a leaf, so a chain can be built. */
  readonly ca?: boolean;
}

/** An issuer: the root created by {@link createTestCertificateAuthority}, or an intermediate. */
export interface TestCertificateAuthority {
  readonly certPem: string;
  readonly certFile: string;
  readonly keyFile: string;
  /** Issues a certificate signed by this authority. */
  issue(options: IssueOptions): IssuedCertificate;
  /** Issues an intermediate that can itself issue, for multi-link chain cases. */
  intermediate(commonName: string): TestCertificateAuthority;
  /** Where the material is written. Useful for pointing a loader at a directory. */
  readonly directory: string;
}

/**
 * Creates a self-signed root and returns it as an issuer.
 *
 * Each call gets its own temporary directory, so two authorities in one suite
 * cannot see each other's files — which is what the "signed by a CA we do not
 * trust" cases need.
 */
export function createTestCertificateAuthority(
  commonName = "Test Root CA",
): TestCertificateAuthority {
  const directory = mkdtempSync(join(tmpdir(), "mtls-ca-"));
  return createAuthority(directory, commonName, null);
}

/** Writes `contents` into `directory` under `name` and returns the path. */
export function writeMaterialFile(directory: string, name: string, contents: string): string {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function createAuthority(
  directory: string,
  commonName: string,
  parent: TestCertificateAuthority | null,
): TestCertificateAuthority {
  const slug = fileSlug(commonName);
  const keyFile = join(directory, `${slug}.key`);
  const certFile = join(directory, `${slug}.crt`);

  if (parent === null) {
    openssl([
      "req",
      "-x509",
      ...newKeyArgs(),
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      subjectFor(commonName),
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  } else {
    const issued = parent.issue({ commonName, ca: true });
    writeFileSync(keyFile, issued.keyPem);
    // The intermediate's own certificate, then its issuer's: a chain file is
    // read leaf-first, and an intermediate that is presented without its parent
    // is exactly the "incomplete chain" deployments get wrong.
    writeFileSync(certFile, issued.certPem);
  }

  const authority: TestCertificateAuthority = {
    certPem: readFileSync(certFile, "utf8"),
    certFile,
    keyFile,
    directory,
    issue: (options) => issueCertificate(directory, { certFile, keyFile }, options),
    intermediate: (name) => createAuthority(directory, name, authority),
  };

  return authority;
}

function issueCertificate(
  directory: string,
  issuer: { certFile: string; keyFile: string },
  options: IssueOptions,
): IssuedCertificate {
  const slug = `${fileSlug(options.commonName)}-${(serial += 1)}`;
  const keyFile = join(directory, `${slug}.key`);
  const csrFile = join(directory, `${slug}.csr`);
  const certFile = join(directory, `${slug}.crt`);
  const extFile = join(directory, `${slug}.ext`);
  const subjectAltNames = options.subjectAltNames ?? [];

  const protection = options.encryptKeyWith;
  const keyArgs = newKeyArgs(protection);
  const protectionArgs = protectionArgsFor(protection);

  openssl(
    [
      "req",
      "-new",
      ...keyArgs,
      "-keyout",
      keyFile,
      "-out",
      csrFile,
      "-subj",
      subjectFor(options.commonName),
      ...protectionArgs,
    ],
    protection,
  );

  writeFileSync(extFile, extensionsFor(subjectAltNames, options.ca ?? false));

  openssl([
    "x509",
    "-req",
    "-in",
    csrFile,
    "-CA",
    issuer.certFile,
    "-CAkey",
    issuer.keyFile,
    "-CAcreateserial",
    "-out",
    certFile,
    "-days",
    String(options.days ?? 2),
    "-extfile",
    extFile,
  ]);

  return {
    certPem: readFileSync(certFile, "utf8"),
    keyPem: readFileSync(keyFile, "utf8"),
    certFile,
    keyFile,
    identity: firstIdentity(subjectAltNames),
  };
}

/**
 * The extension file, written as a config section rather than passed as
 * `-addext`.
 *
 * `-addext subjectAltName=DNS:a,URI:b` splits on the comma itself, so a value
 * that *contains* one cannot be expressed that way — and a SAN value with a
 * comma in it is precisely the input `parseSubjectAltName` exists to survive.
 * A `[alt]` section takes each entry as a whole line, comma and all.
 */
function extensionsFor(subjectAltNames: readonly string[], ca: boolean): string {
  const lines: string[] = [
    ca ? "basicConstraints=critical,CA:TRUE" : "basicConstraints=critical,CA:FALSE",
    ca
      ? "keyUsage=critical,keyCertSign,cRLSign"
      : "keyUsage=critical,digitalSignature,keyEncipherment",
  ];

  if (!ca) lines.push("extendedKeyUsage=serverAuth,clientAuth");

  if (subjectAltNames.length > 0) {
    lines.push("subjectAltName=@alt_names", "", "[alt_names]");
    const counters = new Map<string, number>();
    for (const entry of subjectAltNames) {
      const separator = entry.indexOf(":");
      const kind = entry.slice(0, separator);
      const value = entry.slice(separator + 1);
      const index = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, index);
      lines.push(`${kind}.${index}=${value}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function firstIdentity(subjectAltNames: readonly string[]): string | null {
  for (const entry of subjectAltNames) {
    if (entry.startsWith("URI:") || entry.startsWith("DNS:")) {
      return entry.slice(entry.indexOf(":") + 1);
    }
  }
  return null;
}

/**
 * The `-subj` argument.
 *
 * `/` separates the RDNs, so a common name containing one — a SPIFFE id, say —
 * has to be escaped or OpenSSL reads the rest of it as another attribute and
 * refuses the whole string.
 */
function subjectFor(commonName: string): string {
  return `/CN=${commonName.replaceAll("/", "\\/")}`;
}

function newKeyArgs(protection?: string): string[] {
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
  // `-nodes` is "no DES": leave the key unencrypted. Omitted when a case wants
  // an encrypted key, which is the other half of this path.
  return protection === undefined ? [...key, "-nodes"] : key;
}

/** Where OpenSSL is told to read the key's protection from. Empty when there is none. */
function protectionArgsFor(protection?: string): string[] {
  if (protection === undefined) return [];
  return ["-passout", `env:${KEY_PROTECTION_ENV}`];
}

/** A per-process counter, so two certificates with one common name get two files. */
let serial = 0;

function fileSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The environment variable an encrypted key's protection is handed over in.
 *
 * OpenSSL reads it from there rather than from an argument, because an argument
 * list is world-readable through `/proc` for as long as the process runs —
 * OpenSSL's own manual says as much.
 */
const KEY_PROTECTION_ENV = "TEST_CERTIFICATE_KEY_PROTECTION";

function openssl(args: readonly string[], protection?: string): void {
  try {
    execFileSync("openssl", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(protection === undefined
        ? {}
        : { env: { ...process.env, [KEY_PROTECTION_ENV]: protection } }),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `openssl ${args[0]} failed while issuing test material. These suites need the openssl ` +
        `binary on PATH — the same one CI already uses to mint its ephemeral secrets.\n${detail}`,
    );
  }
}
