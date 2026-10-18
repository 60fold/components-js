#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const suites = ["active-view", "lifecycle", "interaction", "summary"];

const runners = Object.freeze({
  "active-view": "scripts/benchmark-grid.mjs",
  lifecycle: "scripts/benchmark-grid-lifecycle.mjs",
  interaction: "scripts/benchmark-grid-interaction.mjs",
  summary: "scripts/benchmark-grid-summary.mjs",
});

const smokeArguments = Object.freeze({
  "active-view": [
    "--row-scale",
    "0.001",
    "--repetitions",
    "2",
    "--chunk-size",
    "1024",
    "--cancellation-delay-ms",
    "0",
    "--quiet",
    "--output",
    "artifacts/benchmarks/grid/hardened-smoke.json",
  ],
  lifecycle: [
    "--row-scale",
    "0.0001",
    "--ownerships",
    "transfer,copy",
    "--row-id-modes",
    "implicit,explicit-number",
    "--profiles",
    "wide-1m,narrow-10m",
    "--passes",
    "latency,memory",
    "--latency-repetitions",
    "1",
    "--memory-repetitions",
    "1",
    "--post-destroy-settle-ms",
    "10",
    "--quiet",
    "--output",
    "artifacts/benchmarks/grid/lifecycle-smoke.json",
  ],
  interaction: [
    "--row-scale",
    "0.0001",
    "--repetitions",
    "1",
    "--duration-ms",
    "1000",
    "--cadence-hz",
    "60",
    "--settle-ms",
    "10",
    "--quiet",
    "--output",
    "artifacts/benchmarks/grid/interaction-v2-smoke.json",
  ],
  summary: [
    "--row-scale",
    "0.0001",
    "--samples",
    "1",
    "--repetitions",
    "2",
    "--band-count",
    "64",
    "--performance-query-count",
    "256",
    "--oracle-range-count",
    "24",
    "--chunk-size",
    "64",
    "--quiet",
    "--output",
    "artifacts/benchmarks/grid/summary-smoke.json",
  ],
});

const artifactTests = Object.freeze({
  "active-view": ["benchmarks/grid/artifact.test.mjs"],
  lifecycle: ["benchmarks/grid-lifecycle/artifact.test.mjs"],
  interaction: ["benchmarks/grid-interaction/artifact.test.mjs"],
  summary: ["benchmarks/grid-summary/artifact.test.mjs"],
});

const typecheckProjects = Object.freeze({
  "active-view": "benchmarks/grid/tsconfig.json",
  lifecycle: "benchmarks/grid-lifecycle/tsconfig.json",
  interaction: "benchmarks/grid-interaction/tsconfig.json",
  summary: "benchmarks/grid-summary/tsconfig.json",
});

const arguments_ = stripLeadingSeparator(process.argv.slice(2));
const command = arguments_.shift();

if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(helpText());
  process.exit(0);
}

if (command === "smoke" || command === "check" || command === "typecheck") {
  const selectedSuites = selectSuites(arguments_);
  for (const suite of selectedSuites) {
    if (command === "smoke") runSmoke(suite);
    else if (command === "check") runCheck(suite);
    else runTypecheck(suite);
  }
  process.exit(0);
}

if (!suites.includes(command)) fail(`Unknown Grid benchmark suite: ${command}`);
runStep(`${command} benchmark`, process.execPath, [runners[command], ...arguments_]);

function runSmoke(suite) {
  runCheck(suite);
  runStep(`${suite} smoke`, process.execPath, [runners[suite], ...smokeArguments[suite]]);
  runStep(`${suite} artifact validation`, process.execPath, ["--test", ...artifactTests[suite]]);
}

function runCheck(suite) {
  runTypecheck(suite);
  if (suite === "active-view") {
    runStep("active-view profile oracles", pnpm, [
      "exec",
      "vitest",
      "run",
      "--project",
      "grid-benchmarks",
      "benchmarks/grid/src/profiles.test.ts",
    ]);
  } else if (suite === "interaction") {
    runStep("interaction evaluator tests", process.execPath, [
      "--test",
      "benchmarks/grid-interaction/evaluator.test.mjs",
    ]);
  } else if (suite === "summary") {
    runStep("summary evaluator tests", process.execPath, [
      "--test",
      "benchmarks/grid-summary/evaluator.test.mjs",
    ]);
    runStep("summary oracle tests", pnpm, [
      "exec",
      "vitest",
      "run",
      "--project",
      "grid-benchmarks",
      "benchmarks/grid-summary/src/oracle.test.ts",
    ]);
  }
}

function runTypecheck(suite) {
  runStep(`${suite} harness typecheck`, pnpm, ["exec", "tsc", "-p", typecheckProjects[suite]]);
}

function runStep(label, executable, arguments__) {
  process.stderr.write(`\n[grid benchmark suite] ${label}\n`);
  const result = spawnSync(executable, arguments__, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.signal) fail(`${label} terminated by ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function selectSuites(arguments__) {
  const normalized = stripLeadingSeparator(arguments__);
  if (normalized.length === 0 || (normalized.length === 1 && normalized[0] === "all")) {
    return suites;
  }
  if (normalized.length !== 1 || !suites.includes(normalized[0])) {
    fail(`Expected one suite (${suites.join(", ")}) or all.`);
  }
  return [normalized[0]];
}

function stripLeadingSeparator(arguments__) {
  return arguments__[0] === "--" ? arguments__.slice(1) : arguments__;
}

function fail(message) {
  process.stderr.write(`[grid benchmark suite] ${message}\n\n${helpText()}`);
  process.exit(1);
}

function helpText() {
  return `Sixtyfold Grid benchmark suite

Usage:
  pnpm benchmark:grid -- <suite> [suite options]
  pnpm benchmark:grid:smoke [-- <suite|all>]
  pnpm benchmark:grid -- check [suite|all]

Suites:
  active-view  Worker filter, sort, result-oracle, and cancellation behavior
  lifecycle    Public Grid install, ownership, replacement, memory, and cleanup
  interaction  Scroll/resize input-to-publication responsiveness
  summary      Exact hierarchy build, query, memory, provenance, and cancellation

Commands:
  smoke        Run scaled smoke evidence and artifact validation serially
  check        Run typechecks and source-only evaluator/oracle tests serially

Full suites are intentionally selected one at a time because their 1M/10M
defaults are memory-heavy. Use '<suite> --help' for suite-specific options.
`;
}
