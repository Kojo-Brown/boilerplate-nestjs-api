import { X509Certificate } from "node:crypto";
import { createTestCertificateAuthority } from "@/test-utils/test-certificates";
import {
  allowsAnyPeer,
  certificateIdentities,
  isPeerIdentity,
  matchPeerIdentity,
  parseIdentityList,
  parseSubjectAltName,
  peerIdentitiesFrom,
} from "./peer-identity";

describe("parseSubjectAltName", () => {
  it("reads the entries Node renders for an ordinary certificate", () => {
    expect(
      parseSubjectAltName("DNS:localhost, URI:spiffe://cluster.local/ns/prod/sa/orders"),
    ).toEqual([
      { kind: "DNS", value: "localhost" },
      { kind: "URI", value: "spiffe://cluster.local/ns/prod/sa/orders" },
    ]);
  });

  it("treats an absent or empty extension as no entries rather than as an error", () => {
    expect(parseSubjectAltName(undefined)).toEqual([]);
    expect(parseSubjectAltName(null)).toEqual([]);
    expect(parseSubjectAltName("")).toEqual([]);
  });

  it("unescapes a quoted value instead of reading it as two entries", () => {
    // This is the shape Node produces for a value that needs escaping: one
    // entry, JSON-quoted, with the comma written as ,.
    const raw =
      'DNS:"evil.example.com\\u002c URI:spiffe://cluster.local/ns/prod/sa/orders", ' +
      "URI:spiffe://cluster.local/ns/dev/sa/attacker";

    expect(parseSubjectAltName(raw)).toEqual([
      { kind: "DNS", value: "evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders" },
      { kind: "URI", value: "spiffe://cluster.local/ns/dev/sa/attacker" },
    ]);
  });

  it("refuses a string it cannot frame rather than returning what it understood", () => {
    // An unterminated quote, a missing type prefix and a separator that is not
    // Node's are all "we have lost the frame" — and a half-parsed SAN is how an
    // identity nobody holds a key for ends up in an allowlist comparison.
    expect(parseSubjectAltName('DNS:"unterminated')).toBeNull();
    expect(parseSubjectAltName("localhost")).toBeNull();
    expect(parseSubjectAltName("DNS:localhost,URI:spiffe://x/y")).toBeNull();
  });
});

describe("peerIdentitiesFrom", () => {
  it("keeps URI and DNS entries and drops the rest", () => {
    const raw = "DNS:web.internal, IP Address:10.0.0.7, email:ops@example.com, URI:spiffe://c/w";
    expect(peerIdentitiesFrom(raw)).toEqual(["web.internal", "spiffe://c/w"]);
  });

  it("yields nothing for a SAN it could not parse, which is what denies the peer", () => {
    expect(peerIdentitiesFrom('DNS:"unterminated')).toEqual([]);
  });
});

describe("certificateIdentities", () => {
  const ca = createTestCertificateAuthority();

  it("reads both SAN types out of a real certificate", () => {
    const issued = ca.issue({
      commonName: "orders",
      subjectAltNames: ["DNS:orders.internal", "URI:spiffe://cluster.local/ns/prod/sa/orders"],
    });

    expect(certificateIdentities(new X509Certificate(issued.certPem))).toEqual([
      "orders.internal",
      "spiffe://cluster.local/ns/prod/sa/orders",
    ]);
  });

  /**
   * The case the parser exists for, against material OpenSSL actually produced
   * rather than a string a test author imagined.
   *
   * The certificate carries one DNS name whose *value* contains the text of
   * another entry. A peer holding this certificate is a legitimate member of
   * the trust domain — the CA signed it — and it is asking to be read as
   * `spiffe://cluster.local/ns/prod/sa/orders`, a workload whose key it does
   * not have.
   */
  it("does not let a comma inside one SAN value smuggle in a second identity", () => {
    const issued = ca.issue({
      commonName: "sneaky",
      subjectAltNames: [
        "DNS:evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders",
        "URI:spiffe://cluster.local/ns/dev/sa/attacker",
      ],
    });

    const identities = certificateIdentities(new X509Certificate(issued.certPem));

    expect(identities).toEqual([
      "evil.example.com, URI:spiffe://cluster.local/ns/prod/sa/orders",
      "spiffe://cluster.local/ns/dev/sa/attacker",
    ]);
    expect(matchPeerIdentity(identities, ["spiffe://cluster.local/ns/prod/sa/orders"])).toBeNull();
  });
});

describe("isPeerIdentity", () => {
  it.each([
    "spiffe://cluster.local/ns/prod/sa/web",
    "https://orders.internal",
    "orders.internal",
    "localhost",
  ])("accepts %s", (value) => {
    expect(isPeerIdentity(value)).toBe(true);
  });

  it.each([
    ["", "an empty entry, which denies everyone"],
    ["*.internal", "a wildcard, which nothing here expands"],
    [" orders.internal", "untrimmed, so it equals no SAN value"],
    ["not a hostname", "spaces"],
    ["spiffe://", "a scheme and nothing to name"],
  ])("rejects %j: %s", (value) => {
    expect(isPeerIdentity(value)).toBe(false);
  });
});

describe("matchPeerIdentity", () => {
  it("matches a DNS name without regard to case, because the DNS does not have one", () => {
    expect(matchPeerIdentity(["Orders.Internal"], ["orders.internal"])).toBe("Orders.Internal");
  });

  it("matches a SPIFFE id exactly, because its path is case-sensitive", () => {
    const identity = "spiffe://cluster.local/ns/prod/sa/Orders";
    expect(matchPeerIdentity([identity], ["spiffe://cluster.local/ns/prod/sa/orders"])).toBeNull();
    expect(matchPeerIdentity([identity], [identity])).toBe(identity);
  });

  it("returns null when the peer presented nothing to match", () => {
    expect(matchPeerIdentity([], ["orders.internal"])).toBeNull();
  });
});

describe("allowsAnyPeer", () => {
  it("is the single-entry wildcard and nothing else", () => {
    expect(allowsAnyPeer(["*"])).toBe(true);
    expect(allowsAnyPeer(["*", "orders.internal"])).toBe(false);
    expect(allowsAnyPeer([])).toBe(false);
  });
});

describe("parseIdentityList", () => {
  it("trims entries and drops the empty one a trailing comma leaves", () => {
    expect(parseIdentityList(" a.internal , b.internal, ")).toEqual(["a.internal", "b.internal"]);
  });
});
