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
