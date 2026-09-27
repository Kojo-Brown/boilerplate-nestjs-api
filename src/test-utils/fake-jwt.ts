/**
 * A token-shaped string that is unmistakably not a token.
 *
 * `scrubSecrets` has to be tested against something with a JWT's shape, and the
 * obvious way to do that — paste a real-looking token into the spec — is wrong
 * twice over. It puts a credential-shaped literal in the repository, which a
 * secret scanner reports and a reviewer then has to judge; and every such report
 * that turns out to be a fixture is training to skim the next one, which is the
 * "detector nobody believes" failure `docs/log-redaction.md` argues against for
 * the redactor itself.
 *
 * So the fixture is *built* rather than pasted, and built so that the two
 * readers disagree on purpose:
 *
 *   * The scrubber's pattern keys on the `eyJ` prefix — base64url for `{"` — and
 *     three dot-separated base64url segments. This has all of that, so it
 *     exercises the real matcher rather than a weakened one.
 *   * A JWT detector keys on a header that decodes to a JWT header, with an
 *     `alg`. This one decodes to a sentence saying it is a fixture, so it is not
 *     a JWT by anybody's definition and nothing flags it.
 *
 * Writing it out this way also documents what the pattern actually keys on,
 * which a pasted literal does not.
 */
export function fakeJwt(subject = "fixture-subject"): string {
  const segment = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return [
    segment({ note: "not a real token", fixture: true }),
    segment({ sub: subject, note: "not a real claim set" }),
    "signature-is-not-real-and-verifies-against-nothing",
  ].join(".");
}
