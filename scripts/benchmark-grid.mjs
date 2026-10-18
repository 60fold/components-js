#!/usr/bin/env node

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { build as viteBuild } from "vite";
import {
  boundedNumber,
  captureOutcome,
  createStaticServer,
  git,
  hashCanonicalTree,
  list,
  nonNegativeNumber,
  outcomeFailure,
  positiveInteger,
  positiveNumber,
  resolveGridPackageRoot,
  validateList,
} from "./benchmark-grid-runner-utils.mjs";

const PRODUCTION_CHUNK_SIZE = 1_048_576;
const WARM_P95_MINIMUM_SAMPLES = 20;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const gridPackageRoot = await resolveGridPackageRoot(path.resolve(root, options.sourceRoot));
const currentGridPackageRoot = await realpath(path.join(root, "packages/grid")).catch(() => null);
const resolvedGridPackageRoot = await realpath(gridPackageRoot);
const usesExternalSubject =
  currentGridPackageRoot === null || resolvedGridPackageRoot !== currentGridPackageRoot;

const provenance = {
  algorithm: "sha256-canonical-tree-v1",
  canonicalization:
    "Regular files are sorted by POSIX relative path and hashed as path NUL decimal-byte-length NUL raw-bytes. Absolute roots are excluded from the digest.",
  subjectTree: await hashCanonicalTree([
    { root: path.join(gridPackageRoot, "src"), prefix: "src" },
  ]),
  harnessTree: await hashCanonicalTree([
    { root: path.join(root, "benchmarks/grid/index.html"), prefix: "benchmarks/grid/index.html" },
    {
      root: path.join(root, "benchmarks/grid/src/benchmark.worker.ts"),
      prefix: "benchmarks/grid/src/benchmark.worker.ts",
    },
    {
      root: path.join(root, "benchmarks/grid/src/contracts.ts"),
      prefix: "benchmarks/grid/src/contracts.ts",
    },
    { root: path.join(root, "benchmarks/grid/src/main.ts"), prefix: "benchmarks/grid/src/main.ts" },
    {
      root: path.join(root, "benchmarks/grid/src/oracle.ts"),
      prefix: "benchmarks/grid/src/oracle.ts",
    },
    {
      root: path.join(root, "benchmarks/grid/src/profiles.ts"),
      prefix: "benchmarks/grid/src/profiles.ts",
    },
    { root: path.join(root, "scripts/benchmark-grid.mjs"), prefix: "scripts/benchmark-grid.mjs" },
    {
      root: path.join(root, "scripts/benchmark-grid-runner-utils.mjs"),
      prefix: "scripts/benchmark-grid-runner-utils.mjs",
    },
  ]),
};

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sixtyfold-grid-benchmark-"));
const siteRoot = path.join(temporaryRoot, "site");
const startedAt = new Date();

await viteBuild({
  configFile: false,
  root: path.join(root, "benchmarks/grid"),
  publicDir: false,
  logLevel: options.verbose ? "info" : "warn",
  resolve: {
    alias: {
      "@grid-benchmark/active-view": path.join(gridPackageRoot, "src/view/activeView.ts"),
      "@grid-benchmark/store": path.join(gridPackageRoot, "src/data/store.ts"),
      "@grid-benchmark/types": path.join(gridPackageRoot, "src/types.ts"),
    },
  },
  build: {
    outDir: siteRoot,
    emptyOutDir: true,
    target: ["chrome100", "firefox100", "safari16"],
    rollupOptions: { input: path.join(root, "benchmarks/grid/index.html") },
  },
});

const server = createStaticServer(siteRoot);

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const browserType = { chromium, firefox, webkit }[options.browser];
  if (!browserType) throw new Error(`Unsupported browser ${JSON.stringify(options.browser)}.`);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark server has no port.");
  const results = [];
  const outcomes = [];
  const attemptFailures = [];
  let capturedBrowserVersion = null;
  for (const profile of options.profiles) {
    const attempt = await captureOutcome(
      outcomes,
      { profile, timeoutMs: options.timeoutMs },
      async () => {
        const browser = await browserType.launch({ headless: !options.headed });
        capturedBrowserVersion ??= browser.version();
        let context;
        try {
          context = await browser.newContext({
            viewport: { width: 1_280, height: 720 },
            deviceScaleFactor: options.dpr,
          });
          const page = await context.newPage();
          const browserErrors = [];
          page.on("console", (message) => {
            if (message.type() === "error") browserErrors.push(`[console] ${message.text()}`);
          });
          page.on("pageerror", (error) =>
            browserErrors.push(`[page] ${error.stack ?? error.message}`),
          );
          page.on("response", (response) => {
            if (response.status() >= 400) {
              browserErrors.push(`[http ${response.status()}] ${response.url()}`);
            }
          });

          const url = new URL(`http://127.0.0.1:${address.port}/`);
          url.searchParams.set("profile", profile);
          url.searchParams.set("rowScale", String(options.rowScale));
          url.searchParams.set("repetitions", String(options.repetitions));
          url.searchParams.set("cases", options.cases.join(","));
          url.searchParams.set("cancellationDelayMs", String(options.cancellationDelayMs));
          url.searchParams.set("chunkSize", String(options.chunkSize));
          url.searchParams.set("cadenceMode", options.cadenceMode);
          url.searchParams.set("cadenceDescription", cadenceDescription(options));
          process.stderr.write(`[grid benchmark] ${profile}: loading\n`);
          await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
          let lastStage = "";
          const stageLogger = setInterval(async () => {
            const stage = await page
              .evaluate(() => globalThis.__SIXTYFOLD_GRID_BENCHMARK_STAGE__ ?? "not-started")
              .catch(() => "page-unavailable");
            if (stage !== lastStage) {
              process.stderr.write(`[grid benchmark] ${profile}: ${stage}\n`);
              lastStage = stage;
            }
          }, 2_000);
          try {
            await page.waitForFunction(
              () => globalThis.__SIXTYFOLD_GRID_BENCHMARK_RESULT__ !== undefined,
              undefined,
              { timeout: options.timeoutMs },
            );
          } catch (error) {
            const stage = await page
              .evaluate(() => globalThis.__SIXTYFOLD_GRID_BENCHMARK_STAGE__ ?? "not-started")
              .catch(() => "page-unavailable");
            throw new Error(`${profile} stalled at ${stage}.`, { cause: error });
          } finally {
            clearInterval(stageLogger);
          }
          const result = await page.evaluate(() => globalThis.__SIXTYFOLD_GRID_BENCHMARK_RESULT__);
          if (result?.error) throw new Error(`${profile}: ${result.error}`);
          process.stderr.write(
            `[grid benchmark] ${profile}: ${result.failures.length === 0 ? "passed" : `${result.failures.length} failure(s)`}\n`,
          );
          return { ...result, browserErrors };
        } finally {
          await context?.close().catch(() => undefined);
          await browser.close().catch(() => undefined);
        }
      },
    );
    if (attempt.ok) results.push(attempt.value);
    else {
      attemptFailures.push(outcomeFailure(profile, attempt));
      process.stderr.write(`[grid benchmark] ${profile}: ${attempt.status}\n`);
    }
  }

  const failures = [
    ...attemptFailures,
    ...results.flatMap((result) =>
      [...result.failures, ...result.browserErrors.map((error) => `browser error: ${error}`)].map(
        (failure) => `${result.profile.id}: ${failure}`,
      ),
    ),
  ];
  const subjectGitStatus = git(gridPackageRoot, ["status", "--short", "--", "."]);
  const artifact = {
    schemaVersion: 2,
    benchmark: "sixtyfold-grid-active-view",
    provenance,
    source: {
      benchmarkRepositoryRoot: root,
      gridPackageRoot,
      usesExternalSubject,
      gitRevision: git(gridPackageRoot, ["rev-parse", "HEAD"]),
      gitBranch: git(gridPackageRoot, ["branch", "--show-current"]),
      subjectTreeGitDirty: subjectGitStatus === null ? null : subjectGitStatus.length > 0,
    },
    command: [process.execPath, ...process.argv.slice(1)],
    configuration: {
      profiles: options.profiles,
      rowScale: options.rowScale,
      repetitions: options.repetitions,
      cases: options.cases,
      cancellationDelayMs: options.cancellationDelayMs,
      cadenceMode: options.cadenceMode,
      chunkSize: options.chunkSize,
      cadenceDescription: cadenceDescription(options),
      freshBrowserProcessPerProfile: true,
    },
    environment: {
      capturedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      browser: options.browser,
      browserVersion: capturedBrowserVersion,
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      v8: process.versions.v8,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalSystemMemoryBytes: os.totalmem(),
      freeSystemMemoryAtCompletionBytes: os.freemem(),
      devicePixelRatio: options.dpr,
    },
    outcomes,
    profiles: results,
    failures,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const outputPath = path.resolve(root, options.output ?? defaultOutputPath(startedAt));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  if (!options.quiet) process.stdout.write(serialized);
  process.stderr.write(`[grid benchmark] raw artifact: ${outputPath}\n`);
  if (options.enforce && failures.length > 0) {
    throw new Error(`Grid benchmark failed:\n- ${failures.join("\n- ")}`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(arguments_) {
  const parsed = {
    profiles: ["wide-1m", "narrow-10m"],
    rowScale: 1,
    repetitions: 3,
    cases: [
      "filter-numeric",
      "filter-category",
      "sort-1-key",
      "filter-sort-3-key-25pct",
      "builder-cancellation-replacement",
    ],
    cancellationDelayMs: 5,
    chunkSize: PRODUCTION_CHUNK_SIZE,
    cadenceMode: "production",
    browser: "chromium",
    dpr: 1,
    headed: false,
    timeoutMs: 30 * 60 * 1_000,
    sourceRoot: ".",
    output: null,
    enforce: true,
    verbose: false,
    quiet: false,
    help: false,
  };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--headed") parsed.headed = true;
    else if (argument === "--no-enforce") parsed.enforce = false;
    else if (argument === "--verbose") parsed.verbose = true;
    else if (argument === "--quiet") parsed.quiet = true;
    else if (argument === "--profiles") parsed.profiles = list(arguments_[++index]);
    else if (argument === "--cases") parsed.cases = list(arguments_[++index]);
    else if (argument === "--row-scale") {
      parsed.rowScale = boundedNumber(arguments_[++index], argument, 0, 1);
    } else if (argument === "--repetitions") {
      parsed.repetitions = positiveInteger(arguments_[++index], argument);
    } else if (argument === "--cancellation-delay-ms") {
      parsed.cancellationDelayMs = nonNegativeNumber(arguments_[++index], argument);
    } else if (argument === "--chunk-size") {
      parsed.chunkSize = positiveInteger(arguments_[++index], argument);
      parsed.cadenceMode = "custom";
    } else if (argument === "--production-cadence") {
      parsed.chunkSize = PRODUCTION_CHUNK_SIZE;
      parsed.cadenceMode = "production";
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(arguments_[++index], argument);
    } else if (argument === "--dpr") {
      parsed.dpr = positiveNumber(arguments_[++index], argument);
    } else if (argument === "--browser") parsed.browser = arguments_[++index];
    else if (argument === "--source-root") parsed.sourceRoot = arguments_[++index];
    else if (argument === "--output") parsed.output = arguments_[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  validateList(parsed.profiles, ["narrow-10m", "wide-1m"], "profiles");
  validateList(
    parsed.cases,
    [
      "filter-numeric",
      "filter-category",
      "sort-1-key",
      "filter-sort-3-key-25pct",
      "builder-cancellation-replacement",
    ],
    "cases",
  );
  if (
    parsed.cases.includes("builder-cancellation-replacement") &&
    !parsed.cases.includes("filter-numeric")
  ) {
    throw new Error(
      "builder-cancellation-replacement requires filter-numeric for its reference hash/count.",
    );
  }
  return parsed;
}

function cadenceDescription(parsed) {
  return parsed.cadenceMode === "production"
    ? `production: zero-delay worker task after at most ${PRODUCTION_CHUNK_SIZE.toLocaleString("en-US")} processed rows`
    : `custom: zero-delay worker task after at most ${parsed.chunkSize.toLocaleString("en-US")} processed rows`;
}

function defaultOutputPath(date) {
  const stamp = date
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `artifacts/benchmarks/grid/grid-active-view-hardened-${stamp}.json`;
}

function usage() {
  return `Sixtyfold Grid worker benchmark

Usage:
  pnpm benchmark:grid -- active-view [options]

Cadence:
  The default --production-cadence explicitly passes chunkSize=${PRODUCTION_CHUNK_SIZE}.
  It models one zero-delay worker-task yield after at most 1,048,576 processed rows.
  --chunk-size N selects a custom cadence and records that fact in the artifact.

Options:
  --profiles LIST                 wide-1m,narrow-10m (default: 1M then 10M)
  --cases LIST                    filter-numeric,filter-category,sort-1-key,
                                  filter-sort-3-key-25pct,
                                  builder-cancellation-replacement
  --repetitions N                 one first plus N-1 warm samples (default: 3)
  --row-scale N                   debug scale in (0,1]; only 1 is gate evidence
  --production-cadence            explicitly use the pinned production cadence
  --chunk-size N                  custom cancellation/yield cadence
  --cancellation-delay-ms N       delay after first completed sort chunk (default: 5)
  --source-root PATH              repository or packages/grid subject tree
  --output PATH                   raw JSON artifact path
  --browser NAME                  chromium, firefox, or webkit
  --headed                        show the browser
  --no-enforce                    write failures without exiting non-zero
  --quiet                         suppress artifact JSON on stdout
  --verbose                       show Vite output
  --help                          show this help

Warm p95 is null with fewer than ${WARM_P95_MINIMUM_SAMPLES} warm samples.
`;
}
