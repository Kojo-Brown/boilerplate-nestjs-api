import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `stryker.config.mjs` names the files mutation testing covers, and the quiet
 * failure of a scope expressed as a list is that it shrinks: rename
 * `money.ts`, and Stryker reports a perfect score over four files instead of
 * five, with nothing in the run that looks like a problem. Coverage has
 * `collectCoverageFrom` globs and notices; a list does not, so this is the
 * noticing.
 *
 * Read as text rather than imported: the config is ESM and these suites are
 * compiled to CommonJS, so a `require()` of a `.mjs` file fails. The workflow
 * is read the same way in `node-support.spec.ts` for the same reason — what is
 * being asserted is a property of the file somebody edits.
 */
const repoRoot = join(__dirname, "..", "..", "..");
const config = readFileSync(join(repoRoot, "stryker.config.mjs"), "utf8");
const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** The quoted paths inside `mutate: [ … ]`, comments and all skipped. */
const mutatedPaths = (source: string): string[] => {
  const start = source.indexOf("mutate: [");
  const end = source.indexOf("]", start);
  if (start === -1 || end === -1) return [];
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
};

describe("the mutation testing scope", () => {
  const paths = mutatedPaths(config);

  it("is not empty", () => {
    // An empty `mutate` is a run that reports 100% having mutated nothing, and
    // passes every threshold while doing it.
    expect(paths.length).toBeGreaterThan(0);
  });

  it("names files that exist", () => {
    const missing = paths.filter((path) => !existsSync(join(repoRoot, path)));
    expect(missing).toEqual([]);
  });

  it("names source files rather than specs", () => {
    // Mutating a spec produces mutants nothing can kill, so the score collapses
    // for a reason unrelated to the suite's quality.
    expect(paths.filter((path) => path.endsWith(".spec.ts"))).toEqual([]);
  });

  it("names files that have a spec beside them to kill their mutants", () => {
    // A file in `mutate` with no spec covering it contributes only survivors,
    // which reads in a report as a suite problem rather than as a scope
    // mistake. Checked per directory rather than per filename because the
    // repository's co-location is not always one-to-one:
    // `cursor-pagination.spec.ts` is what covers `build-cursor-page.ts`.
    const unspecced = paths.filter((path) => {
      const directory = join(repoRoot, dirname(path));
      const specs = readdirSync(directory).filter((entry) => entry.endsWith(".spec.ts"));
      return specs.length === 0;
    });
    expect(unspecced).toEqual([]);
  });

  it("would notice a scope that had nothing to kill its mutants", () => {
    // The negative control for the assertion above, because "no unspecced
    // files" is also what a filter that never matches anything reports. The
    // same predicate over a directory with no spec in it has to come back
    // non-empty — `src/common/mtls` would do as well; `prisma/` is used because
    // it is not source at all, so it can never acquire one.
    const specs = readdirSync(join(repoRoot, "prisma")).filter((entry) =>
      entry.endsWith(".spec.ts"),
    );
    expect(specs).toEqual([]);
  });

  it("is enforced by a threshold that fails the run", () => {
    // `thresholds.high` and `low` only colour the report. `break` is the one
    // that exits non-zero, and without it the CI job passes at any score.
    expect(config).toMatch(/thresholds:\s*{[^}]*break:\s*\d+/);
  });

  it("runs in CI", () => {
    // A threshold nothing executes is a comment.
    expect(packageJson.scripts["test:mutation"]).toBe("stryker run");
    expect(workflow).toContain("- run: pnpm test:mutation");
  });
});
