import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  testEnvironment: "node",
  collectCoverageFrom: [
    "**/*.ts",
    "!**/*.spec.ts",
    // Benchmarks are run by hand (`pnpm bench:scopes`) and measure rather than
    // assert. Holding one to a coverage threshold would mean asserting on a
    // timing, which is the one thing a CI runner cannot be trusted to
    // reproduce. `testRegex` already keeps them out of the suite.
    "!**/*.bench.ts",
    "!main.ts",
    "!**/*.module.ts",
    "!**/dto/**",
    "!**/index.ts",
    "!**/*.constants.ts",
    "!**/*.types.ts",
    "!**/*.decorator.ts",
    "!**/config/**",
    "!**/prisma.service.ts",
  ],
  coverageDirectory: "../coverage",
  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
    },
  },
};

export default config;
