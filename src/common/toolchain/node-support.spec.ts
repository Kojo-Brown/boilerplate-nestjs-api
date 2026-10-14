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

/**
 * Jobs that deliberately run on a single Node version, and why.
 *
 * The matrix rule below exists to catch an *accidental* hardcode — a job
 * written with `node-version: 22` tests half of what `engines.node` claims to
 * support and nothing else says so. A job with a reason to run once is a
 * different thing, and the way to tell them apart is for the reason to be in
 * the diff. An entry here is checked three ways: the job must really hardcode a
 * version (a stale entry fails), that version must be one `engines.node`
 * supports, and the job must not also declare a matrix.
 */
const SINGLE_VERSION_JOBS: Readonly<Record<string, string>> = {
  mutation:
    "A mutation score is a property of the test suite, not of the runtime. " +
    "The second leg would spend four and a half minutes of runner time to " +
    "report the same number — and if it ever did not, the discrepancy is a " +
    "test behaving differently across Node versions, which is the `test` " +
    "matrix's finding to make and not this job's.",
};

/** The workflow's jobs, split on their two-space-indented keys. */
const jobBlocks = (yaml: string): { readonly id: string; readonly body: string }[] => {
  const jobs = yaml.slice(yaml.indexOf("\njobs:") + 1);
  const headers = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return headers.map((header, index) => ({
    id: header[1] ?? "",
    body: jobs.slice(header.index ?? 0, headers[index + 1]?.index ?? jobs.length),
  }));
};

const hardcodedNodeVersions = (body: string): string[] =>
  [...body.matchAll(/node-version:\s*(.+)/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((version) => version !== "${{ matrix.node }}");

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

    const offenders = jobBlocks(workflow)
      .filter((job) => !(job.id in SINGLE_VERSION_JOBS))
      .filter((job) => hardcodedNodeVersions(job.body).length > 0)
      .map((job) => job.id);

    // Named rather than counted: the failure message is the list of jobs to go
    // and look at.
    expect(offenders).toEqual([]);
  });

  describe("jobs that deliberately run on one version", () => {
    const supported = majorsFromEngines(packageJson.engines?.node ?? "");

    it("are all still hardcoding one, so the list cannot go stale", () => {
      // Without this, an entry outlives the `node-version: 22` it was written
      // for and silently exempts whatever that job id is reused for next.
      const jobs = jobBlocks(workflow);
      for (const id of Object.keys(SINGLE_VERSION_JOBS)) {
        const job = jobs.find((candidate) => candidate.id === id);
        expect(job).toBeDefined();
        expect(hardcodedNodeVersions(job?.body ?? "")).not.toEqual([]);
      }
    });

    it("run a version engines.node actually supports", () => {
      for (const id of Object.keys(SINGLE_VERSION_JOBS)) {
        const job = jobBlocks(workflow).find((candidate) => candidate.id === id);
        for (const version of hardcodedNodeVersions(job?.body ?? "")) {
          expect(supported).toContain(Number(version));
        }
      }
    });

    it("do not also declare a matrix", () => {
      // A job with both would run every matrix leg on one pinned version — the
      // worst of the two, and invisible in a passing run.
      for (const id of Object.keys(SINGLE_VERSION_JOBS)) {
        const job = jobBlocks(workflow).find((candidate) => candidate.id === id);
        expect(matrixDeclarations(job?.body ?? "")).toEqual([]);
      }
    });

    it("say why in a sentence somebody can disagree with", () => {
      for (const reason of Object.values(SINGLE_VERSION_JOBS)) {
        expect(reason.length).toBeGreaterThan(40);
      }
    });
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
    for (const script of ["pnpm test:cov", "pnpm test:e2e", "pnpm test:mutation", "pnpm build"]) {
      const step = workflow.slice(workflow.indexOf(`- run: ${script}`));
      expect(step.slice(0, 120)).toContain("NODE_OPTIONS: --throw-deprecation");
    }
  });
});
