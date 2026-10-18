import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIGS = [
  "benchmarks/grid/tsconfig.json",
  "benchmarks/grid-interaction/tsconfig.json",
  "benchmarks/grid-lifecycle/tsconfig.json",
  "benchmarks/grid-summary/tsconfig.json",
  "tsconfig.tests.json",
  "tsconfig.tests.react.json",
  "tsconfig.tests.solid.json",
  "tsconfig.e2e.json",
];
const IGNORED_DIRECTORIES = new Set([
  ".benchmark-reference",
  ".git",
  "artifacts",
  "coverage",
  "node_modules",
]);
const MINIMUM_TYPESCRIPT_TEST_FILES = 65;
const TEST_FILE_PATTERN = /\.(?:test|spec)(?:\.svelte)?\.tsx?$/;

async function collectTestFiles(directory, collected = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith("dist"))
    ) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(absolute, collected);
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      collected.push(path.normalize(absolute));
    }
  }
  return collected;
}

function resolveConfigFiles(configName) {
  const configPath = path.join(ROOT, configName);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext([loaded.error], diagnosticHost));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost));
  }
  return parsed.fileNames.map((fileName) => path.normalize(path.resolve(fileName)));
}

const diagnosticHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => "\n",
};

const discovered = await collectTestFiles(ROOT);
if (discovered.length < MINIMUM_TYPESCRIPT_TEST_FILES) {
  throw new Error(
    `Expected at least ${MINIMUM_TYPESCRIPT_TEST_FILES} TypeScript test files, found ${discovered.length}. ` +
      "Update the floor only after reviewing an intentional test removal.",
  );
}
const covered = new Set(CONFIGS.flatMap(resolveConfigFiles));
const missing = discovered.filter((fileName) => !covered.has(fileName)).sort();

if (missing.length > 0) {
  throw new Error(
    [
      "TypeScript test files are missing from the test typecheck projects:",
      ...missing.map((fileName) => `- ${path.relative(ROOT, fileName)}`),
    ].join("\n"),
  );
}

console.log(
  `All ${discovered.length} TypeScript test files are covered by an explicit typecheck project.`,
);
