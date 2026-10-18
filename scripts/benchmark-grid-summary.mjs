#!/usr/bin/env node

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { build as viteBuild } from "vite";
import { evaluateSummaryGate } from "../benchmarks/grid-summary/evaluator.mjs";
import {
  boundedNumber,
  captureOutcome,
  createStaticServer,
  delay,
  git,
  hashCanonicalTree,
  integerList,
  list,
  median,
  nonNegativeNumber,
  outcomeFailure,
  positiveInteger,
  positiveNumber,
  resolveGridPackageRoot,
  validateList,
} from "./benchmark-grid-runner-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const gridPackageRoot = await resolveGridPackageRoot(path.resolve(root, options.sourceRoot));
const currentGridRoot = await realpath(path.join(root, "packages/grid")).catch(() => null);
const resolvedGridRoot = await realpath(gridPackageRoot);
const usesExternalSubject = currentGridRoot === null || currentGridRoot !== resolvedGridRoot;
const provenance = {
  algorithm: "sha256-canonical-tree-v1",
  canonicalization:
    "Files are sorted by POSIX relative path and hashed as path NUL decimal-byte-length NUL raw bytes; absolute roots are excluded.",
  subjectTree: await hashCanonicalTree([
    { root: path.join(gridPackageRoot, "src/summary"), prefix: "src/summary" },
    { root: path.join(gridPackageRoot, "src/data/store.ts"), prefix: "src/data/store.ts" },
    { root: path.join(gridPackageRoot, "src/view"), prefix: "src/view" },
    { root: path.join(gridPackageRoot, "src/types.ts"), prefix: "src/types.ts" },
  ]),
  workloadTree: await hashCanonicalTree([
    {
      root: path.join(root, "benchmarks/grid/src/profiles.ts"),
      prefix: "benchmarks/grid/src/profiles.ts",
    },
    {
      root: path.join(root, "benchmarks/grid/src/contracts.ts"),
      prefix: "benchmarks/grid/src/contracts.ts",
    },
  ]),
  harnessTree: await hashCanonicalTree([
    {
      root: path.join(root, "benchmarks/grid-summary/index.html"),
      prefix: "benchmarks/grid-summary/index.html",
    },
    {
      root: path.join(root, "benchmarks/grid-summary/src/benchmark.worker.ts"),
      prefix: "benchmarks/grid-summary/src/benchmark.worker.ts",
    },
    {
      root: path.join(root, "benchmarks/grid-summary/src/contracts.ts"),
      prefix: "benchmarks/grid-summary/src/contracts.ts",
    },
    {
      root: path.join(root, "benchmarks/grid-summary/src/main.ts"),
      prefix: "benchmarks/grid-summary/src/main.ts",
    },
    {
      root: path.join(root, "benchmarks/grid-summary/src/oracle.ts"),
      prefix: "benchmarks/grid-summary/src/oracle.ts",
    },
    {
      root: path.join(root, "benchmarks/grid-summary/evaluator.mjs"),
      prefix: "benchmarks/grid-summary/evaluator.mjs",
    },
    {
      root: path.join(root, "scripts/benchmark-grid-summary.mjs"),
      prefix: "scripts/benchmark-grid-summary.mjs",
    },
    {
      root: path.join(root, "scripts/benchmark-grid-runner-utils.mjs"),
      prefix: "scripts/benchmark-grid-runner-utils.mjs",
    },
  ]),
  toolchainTree: await hashCanonicalTree([
    { root: path.join(root, "package.json"), prefix: "package.json" },
    { root: path.join(root, "pnpm-lock.yaml"), prefix: "pnpm-lock.yaml" },
  ]),
};

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sixtyfold-grid-summary-"));
const siteRoot = path.join(temporaryRoot, "site");
const startedAt = new Date();

await viteBuild({
  configFile: false,
  root: path.join(root, "benchmarks/grid-summary"),
  publicDir: false,
  logLevel: options.verbose ? "info" : "warn",
  resolve: {
    alias: {
      "@grid-benchmark/active-view": path.join(gridPackageRoot, "src/view/activeView.ts"),
      "@grid-benchmark/store": path.join(gridPackageRoot, "src/data/store.ts"),
      "@grid-benchmark/types": path.join(gridPackageRoot, "src/types.ts"),
      "@grid-summary/engine": path.join(gridPackageRoot, "src/summary/summaryHierarchy.ts"),
    },
  },
  build: {
    outDir: siteRoot,
    emptyOutDir: true,
    target: ["chrome100", "firefox100", "safari16"],
    rollupOptions: { input: path.join(root, "benchmarks/grid-summary/index.html") },
  },
});

const server = createStaticServer(siteRoot);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Summary benchmark server has no port.");
const sampleResults = [];
const outcomes = [];
const attemptFailures = [];
try {
  for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
    const combinationCount =
      options.views.length * options.columnScopes.length * options.blockSizes.length;
    const caseOrderRotation = Math.floor((combinationCount * sampleIndex) / options.samples);
    const attempt = await captureOutcome(
      outcomes,
      { sampleIndex, caseOrderRotation, timeoutMs: options.timeoutMs },
      () => runSample({ sampleIndex, caseOrderRotation, port: address.port }),
    );
    if (attempt.ok) sampleResults.push(attempt.value);
    else {
      const label = `sample ${sampleIndex}`;
      attemptFailures.push(outcomeFailure(label, attempt));
      process.stderr.write(`[grid summary] ${label}: ${attempt.status}\n`);
    }
  }

  const configuration = {
    rowScale: options.rowScale,
    freshBrowserSamples: options.samples,
    repetitions: options.repetitions,
    blockSizes: options.blockSizes,
    views: options.views,
    columnScopes: options.columnScopes,
    bandCount: options.bandCount,
    performanceQueryCount: options.performanceQueryCount,
    oracleRangeCount: options.oracleRangeCount,
    chunkSize: options.chunkSize,
    cancellationDelayMs: options.cancellationDelayMs,
    caseOrderRotation:
      "left rotation by floor(combinationCount * freshSampleIndex / freshBrowserSamples)",
    caseOrderOffsets: sampleResults.map((sample) => sample.caseOrderRotation),
  };
  const environment = {
    capturedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    browser: options.browser,
    browserVersion: sampleResults[0]?.runner.browserVersion ?? null,
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    node: process.version,
    v8: process.versions.v8,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalSystemMemoryBytes: os.totalmem(),
    devicePixelRatio: options.dpr,
  };
  const experimentalSummaryGate = evaluateSummaryGate(configuration, environment, sampleResults);
  const failures = [
    ...attemptFailures,
    ...sampleResults.flatMap((sample) => [
      ...sample.page.failures.map((failure) => `sample ${sample.sampleIndex}: ${failure}`),
      ...sample.runner.browserErrors.map(
        (failure) => `sample ${sample.sampleIndex}: browser error: ${failure}`,
      ),
      ...(sample.runner.activeWorkersAfterCompletion === 0
        ? []
        : [
            `sample ${sample.sampleIndex}: ${sample.runner.activeWorkersAfterCompletion} worker(s) remained active.`,
          ]),
    ]),
  ];
  const artifact = {
    schemaVersion: 1,
    benchmark: "sixtyfold-grid-summary-hierarchy",
    provenance,
    source: {
      benchmarkRepositoryRoot: root,
      gridPackageRoot,
      usesExternalSubject,
      gitRevision: git(gridPackageRoot, ["rev-parse", "HEAD"]),
      gitBranch: git(gridPackageRoot, ["branch", "--show-current"]),
      subjectTreeGitDirty:
        (git(gridPackageRoot, ["status", "--short", "--", "."]) ?? "").length > 0,
    },
    command: [process.execPath, ...process.argv.slice(1)],
    configuration,
    environment,
    experimentalSummaryGate,
    summaries: summarizeSamples(sampleResults),
    outcomes,
    samples: sampleResults,
    failures,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const outputPath = path.resolve(root, options.output ?? defaultOutputPath(startedAt));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  if (!options.quiet) process.stdout.write(serialized);
  process.stderr.write(`[grid summary] artifact: ${outputPath}\n`);
  if (options.enforce && failures.length > 0) {
    throw new Error(`Grid summary benchmark failed:\n- ${failures.join("\n- ")}`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runSample({ sampleIndex, caseOrderRotation, port }) {
  const browserType = { chromium, firefox, webkit }[options.browser];
  if (!browserType) throw new Error(`Unsupported browser ${JSON.stringify(options.browser)}.`);
  const browser = await browserType.launch({
    headless: !options.headed,
    ...(options.browser === "chromium" ? { args: ["--enable-precise-memory-info"] } : {}),
  });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1_280, height: 720 },
      deviceScaleFactor: options.dpr,
    });
    const page = await context.newPage();
    const browserErrors = [];
    const activeWorkers = new Set();
    let constructedWorkers = 0;
    let closedWorkers = 0;
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`[console] ${message.text()}`);
    });
    page.on("pageerror", (error) => browserErrors.push(`[page] ${error.stack ?? error.message}`));
    page.on("response", (response) => {
      if (response.status() >= 400)
        browserErrors.push(`[http ${response.status()}] ${response.url()}`);
    });
    page.on("worker", (worker) => {
      constructedWorkers++;
      activeWorkers.add(worker);
      worker.on("close", () => {
        closedWorkers++;
        activeWorkers.delete(worker);
      });
    });

    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set("rowScale", String(options.rowScale));
    url.searchParams.set("sampleIndex", String(sampleIndex));
    url.searchParams.set("caseOrderRotation", String(caseOrderRotation));
    url.searchParams.set("repetitions", String(options.repetitions));
    url.searchParams.set("blockSizes", options.blockSizes.join(","));
    url.searchParams.set("views", options.views.join(","));
    url.searchParams.set("columnScopes", options.columnScopes.join(","));
    url.searchParams.set("bandCount", String(options.bandCount));
    url.searchParams.set("performanceQueryCount", String(options.performanceQueryCount));
    url.searchParams.set("oracleRangeCount", String(options.oracleRangeCount));
    url.searchParams.set("chunkSize", String(options.chunkSize));
    url.searchParams.set("cancellationDelayMs", String(options.cancellationDelayMs));

    process.stderr.write(`[grid summary] sample ${sampleIndex + 1}/${options.samples}: loading\n`);
    await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
    let lastStage = "";
    const logger = setInterval(async () => {
      const stage = await page
        .evaluate(() => globalThis.__SIXTYFOLD_GRID_SUMMARY_STAGE__ ?? "not-started")
        .catch(() => "page-unavailable");
      if (stage !== lastStage) {
        process.stderr.write(`[grid summary] sample ${sampleIndex + 1}: ${stage}\n`);
        lastStage = stage;
      }
    }, 2_000);
    try {
      await page.waitForFunction(
        () => globalThis.__SIXTYFOLD_GRID_SUMMARY_RESULT__ !== undefined,
        undefined,
        { timeout: options.timeoutMs },
      );
    } catch (error) {
      const stage = await page
        .evaluate(() => globalThis.__SIXTYFOLD_GRID_SUMMARY_STAGE__ ?? "not-started")
        .catch(() => "page-unavailable");
      throw new Error(`Summary sample ${sampleIndex + 1} stalled at ${stage}.`, { cause: error });
    } finally {
      clearInterval(logger);
    }
    const pageResult = await page.evaluate(() => globalThis.__SIXTYFOLD_GRID_SUMMARY_RESULT__);
    if (pageResult?.error) throw new Error(pageResult.error);
    await delay(50);
    process.stderr.write(
      `[grid summary] sample ${sampleIndex + 1}: ${pageResult.failures.length === 0 && browserErrors.length === 0 ? "passed" : "failed"}\n`,
    );
    return {
      sampleIndex,
      caseOrderRotation,
      page: pageResult,
      runner: {
        browserVersion: browser.version(),
        constructedWorkers,
        closedWorkers,
        activeWorkersAfterCompletion: activeWorkers.size,
        browserErrors,
      },
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function parseArguments(arguments_) {
  const parsed = {
    rowScale: 1,
    samples: 3,
    repetitions: 2,
    blockSizes: [256],
    views: ["identity", "full-sort", "filtered-sort-25pct"],
    columnScopes: ["two-column", "all-eligible"],
    bandCount: 2_048,
    performanceQueryCount: 2_048,
    oracleRangeCount: 32,
    chunkSize: 1_048_576,
    cancellationDelayMs: 0,
    browser: "chromium",
    dpr: 1,
    timeoutMs: 30 * 60 * 1_000,
    sourceRoot: ".",
    output: null,
    headed: false,
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
    else if (argument === "--row-scale")
      parsed.rowScale = boundedNumber(arguments_[++index], argument, 0, 1);
    else if (argument === "--samples")
      parsed.samples = positiveInteger(arguments_[++index], argument);
    else if (argument === "--repetitions")
      parsed.repetitions = positiveInteger(arguments_[++index], argument);
    else if (argument === "--block-sizes")
      parsed.blockSizes = integerList(arguments_[++index], argument);
    else if (argument === "--views") parsed.views = list(arguments_[++index]);
    else if (argument === "--column-scopes") parsed.columnScopes = list(arguments_[++index]);
    else if (argument === "--band-count")
      parsed.bandCount = positiveInteger(arguments_[++index], argument);
    else if (argument === "--performance-query-count")
      parsed.performanceQueryCount = positiveInteger(arguments_[++index], argument);
    else if (argument === "--oracle-range-count")
      parsed.oracleRangeCount = positiveInteger(arguments_[++index], argument);
    else if (argument === "--chunk-size")
      parsed.chunkSize = positiveInteger(arguments_[++index], argument);
    else if (argument === "--cancellation-delay-ms")
      parsed.cancellationDelayMs = nonNegativeNumber(arguments_[++index], argument);
    else if (argument === "--browser") parsed.browser = arguments_[++index];
    else if (argument === "--dpr") parsed.dpr = positiveNumber(arguments_[++index], argument);
    else if (argument === "--timeout-ms")
      parsed.timeoutMs = positiveInteger(arguments_[++index], argument);
    else if (argument === "--source-root") parsed.sourceRoot = arguments_[++index];
    else if (argument === "--output") parsed.output = arguments_[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  validateList(parsed.views, ["identity", "full-sort", "filtered-sort-25pct"], "views");
  validateList(parsed.columnScopes, ["two-column", "all-eligible"], "column-scopes");
  validateList([parsed.browser], ["chromium", "firefox", "webkit"], "browser");
  return parsed;
}

function usage() {
  return (
    `Usage: pnpm benchmark:grid -- summary [options]\n\n` +
    `  --row-scale <0..1>             Dataset scale (default 1)\n` +
    `  --samples <n>                  Fresh browser processes (default 3)\n` +
    `  --repetitions <n>              Builds per combination (decision config exactly 2)\n` +
    `  --block-sizes <csv>            Default 256\n` +
    `  --band-count <n>               Default 2048\n` +
    `  --performance-query-count <n>  Default 2048\n` +
    `  --output <path>                Artifact path\n`
  );
}

function summarizeSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    for (const entry of sample.page.samples) {
      const key = `${entry.viewId}/${entry.columnScope}/${entry.blockSize}/${entry.temperature}`;
      const values = groups.get(key) ?? [];
      values.push(entry);
      groups.set(key, values);
    }
  }
  return [...groups.entries()].map(([key, entries]) => ({
    key,
    samples: entries.length,
    buildMedianMs: median(entries.map((entry) => entry.buildDurationMs)),
    buildMaximumMs: Math.max(...entries.map((entry) => entry.buildDurationMs)),
    queryP95MaximumMs: Math.max(...entries.map((entry) => entry.query.p95DurationMs)),
    retainedBytesMaximum: Math.max(...entries.map((entry) => entry.retainedBytes)),
    stagedReplacementPeakBytesMaximum: Math.max(
      ...entries.map((entry) => entry.stagedReplacementPeakBytes),
    ),
  }));
}

function defaultOutputPath(date) {
  return path.join(
    "artifacts/benchmarks/grid",
    `summary-${date.toISOString().replaceAll(":", "-")}.json`,
  );
}
