import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The supported Node versions are declared once, in `engines.node`, and are
 * meant to be mirrored by the CI matrix. Nothing in the toolchain enforces
 * that — a version added to `engines` but not to the matrix is simply never
 * tested — so this spec is the enforcement.
 */
const repoRoot = join(__dirname, "..", "..", "..");

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const packageJson = JSON.parse(readRepoFile("package.json")) as {
  engines?: { node?: string };
  scripts: Record<string, string>;
};
const workflow = readRepoFile(".github/workflows/ci.yml");
const npmrc = readRepoFile(".npmrc");

/** `"^22.12.0 || ^24.0.0"` -> `[22, 24]` */
const majorsFromEngines = (range: string): number[] =>
  [...range.matchAll(/\^(\d+)\./g)].map((match) => Number(match[1]));

/** Every `node: [22, 24]` matrix declaration in the workflow. */
const matrixDeclarations = (yaml: string): number[][] =>
  [...yaml.matchAll(/^\s*node:\s*\[([^\]]+)\]\s*$/gm)].map((match) =>
    (match[1] ?? "").split(",").map((entry) => Number(entry.trim())),
  );

describe("Node version support", () => {
  it("declares the supported Node versions in engines.node", () => {
    expect(packageJson.engines?.node).toBeDefined();
    expect(majorsFromEngines(packageJson.engines?.node ?? "").length).toBeGreaterThan(0);
  });

  it("runs a CI matrix for every supported major version", () => {
    const supported = majorsFromEngines(packageJson.engines?.node ?? "");
    const declarations = matrixDeclarations(workflow);

    expect(declarations.length).toBeGreaterThan(0);
    for (const matrix of declarations) {
      expect([...matrix].sort()).toEqual([...supported].sort());
    }
  });

  it("pins every CI job to the matrix rather than a hardcoded version", () => {
    const nodeVersions = [...workflow.matchAll(/node-version:\s*(.+)/g)].map((match) =>
      (match[1] ?? "").trim(),
    );

    expect(nodeVersions.length).toBeGreaterThan(0);
    for (const version of nodeVersions) {
      expect(version).toBe("${{ matrix.node }}");
    }
  });
});

describe("Warnings are failures", () => {
  it("fails linting on any ESLint warning", () => {
    expect(packageJson.scripts.lint).toContain("--max-warnings 0");
  });

  it("fails installation on peer mismatches and unsupported runtimes", () => {
    expect(npmrc).toContain("strict-peer-dependencies=true");
    expect(npmrc).toContain("engine-strict=true");
  });

  it("throws on Node deprecation warnings in every CI script step", () => {
    // The test, e2e, and build steps are the ones that actually execute
    // application code, so they are the ones that can emit runtime warnings.
    for (const script of ["pnpm test:cov", "pnpm test:e2e", "pnpm build"]) {
      const step = workflow.slice(workflow.indexOf(`- run: ${script}`));
      expect(step.slice(0, 120)).toContain("NODE_OPTIONS: --throw-deprecation");
    }
  });
});
