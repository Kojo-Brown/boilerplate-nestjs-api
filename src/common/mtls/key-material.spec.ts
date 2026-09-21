import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestCertificateAuthority, writeMaterialFile } from "@/test-utils/test-certificates";
import type { TestCertificateAuthority } from "@/test-utils/test-certificates";
import {
  KeyMaterialError,
  describeKeyMaterial,
  loadKeyMaterial,
  millisecondsUntilExpiry,
} from "./key-material";

const IDENTITY = "spiffe://cluster.local/ns/prod/sa/orders";
/**
 * A minute after the suite starts, which is how a certificate issued *during*
 * the suite is inside its own validity window: OpenSSL writes `notBefore` at
 * second granularity from the moment it signs, which is after this module was
 * loaded. Every case that cares about the window moves days, not seconds.
 */
const NOW = new Date(Date.now() + 60_000);

/** The three files a mesh mounts, written into the authority's own directory. */
function materialFor(
  ca: TestCertificateAuthority,
  options: { identity?: string; passphrase?: string; anchor?: string } = {},
) {
  const issued = ca.issue({
    commonName: "orders",
    subjectAltNames: [`URI:${options.identity ?? IDENTITY}`, "DNS:orders.internal"],
    ...(options.passphrase === undefined ? {} : { encryptKeyWith: options.passphrase }),
  });
  const caFile = writeMaterialFile(
    ca.directory,
    `anchor-${Math.random().toString(36).slice(2)}.pem`,
    options.anchor ?? ca.certPem,
  );
  return { certFile: issued.certFile, keyFile: issued.keyFile, caFile, issued };
}

describe("loadKeyMaterial", () => {
  const ca = createTestCertificateAuthority();

  it("loads a matching trio and reports what the certificate says", () => {
    const files = materialFor(ca);

    const material = loadKeyMaterial(files, { now: NOW });

    expect(material.identities).toEqual([IDENTITY, "orders.internal"]);
    expect(material.notBefore.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(material.notAfter.getTime()).toBeGreaterThan(NOW.getTime());
    expect(material.ca).toHaveLength(1);
    expect(material.fingerprint).toContain(":");
  });

  it("decrypts an encrypted key with the passphrase, and refuses it without one", () => {
    const files = materialFor(ca, { passphrase: "not-a-real-passphrase" });

    expect(loadKeyMaterial(files, { now: NOW, passphrase: "not-a-real-passphrase" }).key).toContain(
      "ENCRYPTED PRIVATE KEY",
    );
    expect(() => loadKeyMaterial(files, { now: NOW })).toThrow(KeyMaterialError);
  });

  it("names the file it could not read", () => {
    const files = materialFor(ca);

    expect(() =>
      loadKeyMaterial({ ...files, keyFile: join(ca.directory, "absent.key") }, { now: NOW }),
    ).toThrow(/absent\.key.*ENOENT/s);
  });

  /**
   * The half-finished rotation, which is the failure this whole file exists
   * for: the certificate has been replaced and the key has not. OpenSSL will
   * not build a context from that pair, and without this check the first
   * evidence is `ERR_SSL_KEY_VALUES_MISMATCH` thrown from inside
   * `https.createServer` at the first connection.
   */
  it("refuses a key that does not belong to the certificate", () => {
    const first = materialFor(ca);
    const second = materialFor(ca);

    expect(() => loadKeyMaterial({ ...first, keyFile: second.keyFile }, { now: NOW })).toThrow(
      /private key .* does not match the certificate/,
    );
  });

  it("refuses a certificate file that holds no certificate", () => {
    const files = materialFor(ca);
    const emptyFile = writeMaterialFile(ca.directory, "empty.crt", "");

    expect(() => loadKeyMaterial({ ...files, certFile: emptyFile }, { now: NOW })).toThrow(
      /contains no PEM certificate block/,
    );
  });

  it("refuses a certificate that has expired, rather than presenting it", () => {
    const files = materialFor(ca);
    const wellAfterExpiry = new Date(NOW.getTime() + 30 * 86_400_000);

    expect(() => loadKeyMaterial(files, { now: wellAfterExpiry })).toThrow(/expired at/);
  });

  it("refuses a certificate that is not valid yet, which is usually a clock", () => {
    const files = materialFor(ca);
    const beforeIssuance = new Date(NOW.getTime() - 30 * 86_400_000);

    expect(() => loadKeyMaterial(files, { now: beforeIssuance })).toThrow(/not valid until/);
  });

  /**
   * The other half of a rotation gone wrong: the leaf was replaced with one
   * from a new CA and the trust bundle still holds the old anchor. Both files
   * parse, both are in date, and every handshake fails with an alert that names
   * neither of them.
   */
  it("refuses a leaf that does not chain to any anchor in the bundle", () => {
    const otherCa = createTestCertificateAuthority("Other Root CA");
    const files = materialFor(ca, { anchor: otherCa.certPem });

    expect(() => loadKeyMaterial(files, { now: NOW })).toThrow(/does not chain to any anchor/);
  });

  it("follows an intermediate from the certificate file up to the anchor", () => {
    const intermediate = ca.intermediate("Test Intermediate CA");
    const leaf = intermediate.issue({
      commonName: "orders",
      subjectAltNames: [`URI:${IDENTITY}`],
    });
    // A chain file is the leaf followed by its issuers. The anchor stays the
    // root: an intermediate presented without it is the classic incomplete
    // chain, and it has to be the presented chain that closes the gap.
    const chainFile = writeMaterialFile(
      ca.directory,
      "chain.crt",
      `${leaf.certPem}${intermediate.certPem}`,
    );
    const caFile = writeMaterialFile(ca.directory, "root-only.pem", ca.certPem);

    const material = loadKeyMaterial(
      { certFile: chainFile, keyFile: leaf.keyFile, caFile },
      { now: NOW },
    );

    expect(material.identities).toEqual([IDENTITY]);
  });

  it("refuses a chain whose intermediate is missing", () => {
    const intermediate = ca.intermediate("Lonely Intermediate CA");
    const leaf = intermediate.issue({ commonName: "orders", subjectAltNames: [`URI:${IDENTITY}`] });
    const caFile = writeMaterialFile(ca.directory, "root-only-2.pem", ca.certPem);

    expect(() =>
      loadKeyMaterial({ certFile: leaf.certFile, keyFile: leaf.keyFile, caFile }, { now: NOW }),
    ).toThrow(/does not chain to any anchor/);
  });

  it("refuses a trust bundle that is not a certificate at all", () => {
    const files = materialFor(ca);
    const garbage = join(ca.directory, "garbage.pem");
    writeFileSync(
      garbage,
      "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n",
    );

    expect(() => loadKeyMaterial({ ...files, caFile: garbage }, { now: NOW })).toThrow(
      /is not a certificate this runtime can parse/,
    );
  });

  it("changes fingerprint when the anchor changes, even though the leaf did not", () => {
    const files = materialFor(ca);
    const secondCa = createTestCertificateAuthority("Second Root CA");
    const bothAnchors = writeMaterialFile(
      ca.directory,
      "both.pem",
      `${ca.certPem}${secondCa.certPem}`,
    );

    const before = loadKeyMaterial(files, { now: NOW });
    const after = loadKeyMaterial({ ...files, caFile: bothAnchors }, { now: NOW });

    // A trust bundle that gained the next CA is exactly the first step of a CA
    // rotation, and a service that treated it as "nothing changed" would keep
    // rejecting the peers that have already moved.
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.ca).toHaveLength(2);
  });
});

describe("expiry reporting", () => {
  const ca = createTestCertificateAuthority("Expiry CA");

  it("counts down to the earliest expiry in the set, anchors included", () => {
    const shortLivedCa = createTestCertificateAuthority("Short Lived CA");
    const leaf = ca.issue({ commonName: "orders", subjectAltNames: [`URI:${IDENTITY}`], days: 2 });
    // The anchor outlives nothing here; in a real deployment it is the leaf
    // that is short-lived and the CA that quietly runs out years later.
    const caFile = writeMaterialFile(
      ca.directory,
      "anchors.pem",
      `${ca.certPem}${shortLivedCa.certPem}`,
    );

    const material = loadKeyMaterial(
      { certFile: leaf.certFile, keyFile: leaf.keyFile, caFile },
      { now: NOW },
    );

    expect(material.expiresAt.getTime()).toBeLessThanOrEqual(material.notAfter.getTime());
    expect(millisecondsUntilExpiry(material, NOW)).toBeGreaterThan(0);
    expect(
      millisecondsUntilExpiry(material, new Date(NOW.getTime() + 10 * 86_400_000)),
    ).toBeLessThan(0);
  });

  it("describes the material in one line, identities first", () => {
    const leaf = ca.issue({ commonName: "orders", subjectAltNames: [`URI:${IDENTITY}`] });
    const caFile = writeMaterialFile(ca.directory, "describe.pem", ca.certPem);

    const description = describeKeyMaterial(
      loadKeyMaterial({ certFile: leaf.certFile, keyFile: leaf.keyFile, caFile }, { now: NOW }),
    );

    expect(description).toContain(`identities=[${IDENTITY}]`);
    expect(description).toContain("fingerprint=");
  });

  it("says so when the certificate carries no identity at all", () => {
    const leaf = ca.issue({ commonName: "no-san" });
    const caFile = writeMaterialFile(ca.directory, "describe-2.pem", ca.certPem);

    const material = loadKeyMaterial(
      { certFile: leaf.certFile, keyFile: leaf.keyFile, caFile },
      { now: NOW },
    );

    expect(material.identities).toEqual([]);
    expect(describeKeyMaterial(material)).toContain("<no URI or DNS SAN>");
  });
});
