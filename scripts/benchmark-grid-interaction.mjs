#!/usr/bin/env node

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { build as viteBuild } from "vite";
import {
  INTERACTION_SCENARIOS as SCENARIOS,
  buildInteractionGate,
} from "../benchmarks/grid-interaction/evaluator.mjs";
import {
  boundedNumber,
  browserDistribution,
  captureOutcome,
  createStaticServer,
  git,
  hashCanonicalTree,
  isNumber,
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
const requireFromHere = createRequire(import.meta.url);
const playwrightVersion = requireFromHere("@playwright/test/package.json").version;
const browserTypes = { chromium, firefox, webkit };

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const gridPackageRoot = await resolveGridPackageRoot(path.resolve(root, options.sourceRoot));
const resolvedGridPackageRoot = await realpath(gridPackageRoot);
const currentGridPackageRoot = await realpath(path.join(root, "packages/grid")).catch(() => null);
const usesExternalSubject =
  currentGridPackageRoot === null || resolvedGridPackageRoot !== currentGridPackageRoot;
const startedAt = new Date();
const provenance = {
  methodologyVersion: "grid-interaction-v2-trusted-horizontal-driver",
  algorithm: "sha256-canonical-tree-v1",
  canonicalization:
    "Regular files are sorted by POSIX relative path and hashed as path NUL decimal-byte-length NUL raw-bytes. Absolute roots are excluded from the digest.",
  subjectTree: await hashCanonicalTree([
    { root: path.join(gridPackageRoot, "src"), prefix: "src" },
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
      root: path.join(root, "benchmarks/grid-interaction/index.html"),
      prefix: "benchmarks/grid-interaction/index.html",
    },
    {
      root: path.join(root, "benchmarks/grid-interaction/src"),
      prefix: "benchmarks/grid-interaction/src",
    },
    {
      root: path.join(root, "benchmarks/grid-interaction/evaluator.mjs"),
      prefix: "benchmarks/grid-interaction/evaluator.mjs",
    },
    {
      root: path.join(root, "scripts/benchmark-grid-interaction.mjs"),
      prefix: "scripts/benchmark-grid-interaction.mjs",
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

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sixtyfold-grid-interaction-"));
const siteRoot = path.join(temporaryRoot, "site");
let server;
try {
  await viteBuild({
    configFile: false,
    root: path.join(root, "benchmarks/grid-interaction"),
    publicDir: false,
    logLevel: options.verbose ? "info" : "warn",
    resolve: {
      alias: {
        "@grid-interaction/grid": path.join(gridPackageRoot, "src/index.ts"),
        "@grid-interaction/telemetry": path.join(
          gridPackageRoot,
          "src/internal/surfaceTelemetry.ts",
        ),
        "@grid-interaction/profiles": path.join(root, "benchmarks/grid/src/profiles.ts"),
        "@grid-interaction/types": path.join(gridPackageRoot, "src/types.ts"),
        "@grid-benchmark/types": path.join(gridPackageRoot, "src/types.ts"),
      },
    },
    build: {
      outDir: siteRoot,
      emptyOutDir: true,
      target: ["chrome100", "firefox100", "safari16"],
      rollupOptions: { input: path.join(root, "benchmarks/grid-interaction/index.html") },
    },
  });

  server = createStaticServer(siteRoot);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark server has no port.");

  const samples = [];
  const outcomes = [];
  const attemptFailures = [];
  for (const scenario of options.scenarios) {
    for (let sampleIndex = 0; sampleIndex < options.repetitions; sampleIndex++) {
      const attempt = await captureOutcome(
        outcomes,
        { scenario, sampleIndex, timeoutMs: options.timeoutMs },
        () => runSample({ scenario, sampleIndex, port: address.port }),
      );
      if (attempt.ok) samples.push(attempt.value);
      else {
        const label = `${scenario}/${sampleIndex}`;
        attemptFailures.push(outcomeFailure(label, attempt));
        process.stderr.write(`[grid interaction] ${label}: ${attempt.status}\n`);
      }
    }
  }
  const failures = [
    ...attemptFailures,
    ...samples.flatMap((sample) => [
      ...sample.page.failures.map(
        (failure) =>
          `${sample.page.configuration.scenario}/${sample.page.configuration.sampleIndex}: ${failure}`,
      ),
      ...sample.runner.browserErrors.map(
        (failure) =>
          `${sample.page.configuration.scenario}/${sample.page.configuration.sampleIndex}: ${failure}`,
      ),
      ...(sample.runner.gridWorkersConstructed !== 2
        ? [
            `${sample.page.configuration.scenario}/${sample.page.configuration.sampleIndex}: expected exactly two Grid workers, observed ${sample.runner.gridWorkersConstructed}.`,
          ]
        : []),
      ...(sample.runner.gridWorkersActiveAfterDestroy === 0
        ? []
        : [
            `${sample.page.configuration.scenario}/${sample.page.configuration.sampleIndex}: ${sample.runner.gridWorkersActiveAfterDestroy} Grid workers remained after destroy.`,
          ]),
    ]),
  ];
  const experimentalGate = buildInteractionGate(samples, options, failures);
  const artifact = {
    schemaVersion: 2,
    benchmark: "sixtyfold-grid-interaction-pipeline",
    methodologyVersion: "grid-interaction-v2-trusted-horizontal-driver",
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
    configuration: {
      scenarios: options.scenarios,
      rowScale: options.rowScale,
      repetitions: options.repetitions,
      durationMs: options.durationMs,
      cadenceHz: options.cadenceHz,
      settleMs: options.settleMs,
      browser: options.browser,
      dpr: options.dpr,
      timeoutMs: options.timeoutMs,
      sourceRoot: options.sourceRoot,
      headed: options.headed,
      freshBrowserProcessPerSample: true,
      viewport: { width: 1280, height: 720 },
      host: { width: 960, height: 540 },
    },
    environment: {
      capturedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      browser: options.browser,
      browserVersion: samples[0]?.runner.browserVersion ?? null,
      browserDistribution: browserDistribution(options.browser),
      automation: { name: "playwright", version: playwrightVersion, headless: !options.headed },
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      v8: process.versions.v8,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalSystemMemoryBytes: os.totalmem(),
      devicePixelRatio: options.dpr,
    },
    experimentalGate,
    summaries: buildSummaries(samples),
    outcomes,
    samples,
    failures,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const outputPath = path.resolve(root, options.output ?? defaultOutputPath(startedAt));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  if (!options.quiet) process.stdout.write(serialized);
  process.stderr.write(`[grid interaction] raw artifact: ${outputPath}\n`);
  process.stderr.write(`[grid interaction] experimental decision: ${experimentalGate.decision}\n`);
  if (options.enforce && failures.length > 0) {
    throw new Error(`Grid interaction harness failed:\n- ${failures.join("\n- ")}`);
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runSample({ scenario, sampleIndex, port }) {
  const browserType = browserTypes[options.browser];
  const browser = await browserType.launch({ headless: !options.headed });
  const browserVersion = browser.version();
  let context;
  let cdpSession;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: options.dpr,
    });
    const page = await context.newPage();
    if (options.browser === "chromium") cdpSession = await context.newCDPSession(page);
    const browserErrors = [];
    const workers = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`[console] ${message.text()}`);
    });
    page.on("pageerror", (error) => browserErrors.push(`[page] ${error.stack ?? error.message}`));
    page.on("response", (response) => {
      if (response.status() >= 400)
        browserErrors.push(`[http ${response.status()}] ${response.url()}`);
    });
    page.on("worker", (worker) => {
      const entry = { url: worker.url(), active: true };
      workers.push(entry);
      worker.on("close", () => {
        entry.active = false;
      });
    });

    const profile =
      scenario === "vertical-wheel" || scenario === "compressed-thumb" ? "narrow-10m" : "wide-1m";
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set("profile", profile);
    url.searchParams.set("scenario", scenario);
    url.searchParams.set("rowScale", String(options.rowScale));
    url.searchParams.set("sampleIndex", String(sampleIndex));
    url.searchParams.set("durationMs", String(options.durationMs));
    url.searchParams.set("cadenceHz", String(options.cadenceHz));
    url.searchParams.set("settleMs", String(options.settleMs));
    const label = `${scenario}/${sampleIndex + 1}`;
    process.stderr.write(`[grid interaction] ${label}: loading fresh ${options.browser} process\n`);
    await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
    await page.waitForFunction(
      () => globalThis.__SIXTYFOLD_GRID_INTERACTION_CONTROL__ !== undefined,
      undefined,
      { timeout: options.timeoutMs },
    );
    const geometry = await page.evaluate(() =>
      globalThis.__SIXTYFOLD_GRID_INTERACTION_CONTROL__.begin(),
    );
    const inputDriver = await driveScenario(page, cdpSession, scenario, geometry);
    await page.evaluate(() => globalThis.__SIXTYFOLD_GRID_INTERACTION_CONTROL__.driverFinished());
    await page.waitForFunction(
      () => globalThis.__SIXTYFOLD_GRID_INTERACTION_RESULT__ !== undefined,
      undefined,
      { timeout: options.timeoutMs },
    );
    const result = await page.evaluate(() => globalThis.__SIXTYFOLD_GRID_INTERACTION_RESULT__);
    if (result?.error) throw new Error(`${label}: ${result.error}`);
    await waitMilliseconds(100);
    const gridWorkers = workers.filter((entry) => !entry.url.includes("generator.worker"));
    process.stderr.write(
      `[grid interaction] ${label}: ${result.failures.length === 0 ? "passed" : `${result.failures.length} failure(s)`}\n`,
    );
    return {
      page: result,
      runner: {
        browserVersion,
        browserErrors,
        gridWorkersConstructed: gridWorkers.length,
        gridWorkersActiveAfterDestroy: gridWorkers.filter((entry) => entry.active).length,
        inputDriver: {
          kind: inputDriver.kind,
          actualCommandDurationMs: inputDriver.actualCommandDurationMs,
        },
      },
    };
  } finally {
    await cdpSession?.detach().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser.close();
  }
}

async function driveScenario(page, cdpSession, scenario, geometry) {
  const centerX = geometry.scrollport.x + geometry.scrollport.width / 2;
  const centerY = geometry.scrollport.y + geometry.scrollport.height / 2;
  const intervalMs = 1000 / options.cadenceHz;
  if (scenario === "compressed-thumb") {
    const fractions = [0, 0.25, 0.5, 0.75, 1, 0.5, 0];
    const stepMs = options.durationMs / Math.max(1, fractions.length - 1);
    const startedAt = performance.now();
    for (let index = 0; index < fractions.length; index++) {
      const fraction = fractions[index];
      await page.evaluate((value) => {
        globalThis.__SIXTYFOLD_GRID_INTERACTION_CONTROL__.setCompressedThumbFraction(value);
      }, fraction);
      if (index < fractions.length - 1) await waitUntil(startedAt + (index + 1) * stepMs);
    }
    return {
      kind: "programmatic-native-scroll-offset-checkpoints",
      requestedDurationMs: options.durationMs,
      requestedCheckpointFractions: fractions,
      actualCommandDurationMs: performance.now() - startedAt,
      browserGeneratedInput: false,
    };
  }
  const steps = Math.max(2, Math.round((options.durationMs / 1000) * options.cadenceHz));
  if (scenario === "resize-drag") {
    if (!geometry.resizeHandle) throw new Error("The resize handle is missing.");
    const x = geometry.resizeHandle.x + geometry.resizeHandle.width / 2;
    const y = geometry.resizeHandle.y + geometry.resizeHandle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const startedAt = performance.now();
    for (let index = 0; index < steps; index++) {
      const final = index === steps - 1;
      const offset = final ? 48 : index % 2 === 0 ? 72 : 8;
      await page.mouse.move(x + offset, y, { steps: 1 });
      await waitUntil(startedAt + (index + 1) * intervalMs);
    }
    await page.mouse.up();
    return {
      kind: "playwright-trusted-pointer-drag",
      requestedDurationMs: options.durationMs,
      requestedCadenceHz: options.cadenceHz,
      requestedStepCount: steps,
      actualCommandDurationMs: performance.now() - startedAt,
      browserGeneratedInput: true,
    };
  }
  await page.mouse.move(centerX, centerY);
  const startedAt = performance.now();
  if (scenario === "vertical-wheel") {
    for (let index = 0; index < steps; index++) {
      await page.mouse.wheel(0, 1200);
      await waitUntil(startedAt + (index + 1) * intervalMs);
    }
    return {
      kind: "playwright-trusted-mouse-wheel",
      requestedDurationMs: options.durationMs,
      requestedCadenceHz: options.cadenceHz,
      requestedStepCount: steps,
      actualCommandDurationMs: performance.now() - startedAt,
      browserGeneratedInput: true,
    };
  }
  if (cdpSession) {
    const requestedHalfDurationMs = options.durationMs / 2;
    const requestedSpeedPxPerSecond = Math.max(
      1,
      Math.round(geometry.maximumLeft / (requestedHalfDurationMs / 1_000)),
    );
    const command = {
      x: Math.round(centerX),
      y: Math.round(centerY),
      yDistance: 0,
      speed: requestedSpeedPxPerSecond,
      gestureSourceType: "mouse",
      preventFling: true,
    };
    const farStartedAt = performance.now();
    await cdpSession.send("Input.synthesizeScrollGesture", {
      ...command,
      xDistance: -geometry.maximumLeft,
      interactionMarkerName: "sixtyfold-grid-horizontal-far",
    });
    const farCommandDurationMs = performance.now() - farStartedAt;
    const returnStartedAt = performance.now();
    await cdpSession.send("Input.synthesizeScrollGesture", {
      ...command,
      xDistance: geometry.maximumLeft,
      interactionMarkerName: "sixtyfold-grid-horizontal-return",
    });
    const returnCommandDurationMs = performance.now() - returnStartedAt;
    return {
      kind: "chromium-cdp-synthesize-scroll-gesture",
      protocolCommand: "Input.synthesizeScrollGesture",
      gestureSourceType: "mouse",
      requestedDurationMs: options.durationMs,
      requestedHalfDurationMs,
      requestedDistancePx: geometry.maximumLeft,
      requestedSpeedPxPerSecond,
      farCommandDurationMs,
      returnCommandDurationMs,
      actualCommandDurationMs: performance.now() - startedAt,
      browserGeneratedInput: true,
      browserInputEvidence:
        "Chromium DevTools Input domain synthesized the mouse-source scroll gesture.",
    };
  }
  const half = Math.max(1, Math.floor(steps / 2));
  const delta = Math.max(1, geometry.maximumLeft / half);
  for (let index = 0; index < steps; index++) {
    await page.mouse.wheel(index < half ? delta : -delta, 0);
    await waitUntil(startedAt + (index + 1) * intervalMs);
  }
  return {
    kind: "playwright-trusted-mouse-wheel-fallback",
    requestedDurationMs: options.durationMs,
    requestedCadenceHz: options.cadenceHz,
    requestedStepCount: steps,
    actualCommandDurationMs: performance.now() - startedAt,
    browserGeneratedInput: true,
  };
}

function buildSummaries(samples) {
  return options.scenarios.map((scenario) => {
    const group = samples.filter((sample) => sample.page.configuration.scenario === scenario);
    const values = (selector) => group.map(selector).filter(isNumber);
    return {
      scenario,
      profile: group[0]?.page.configuration.profile ?? null,
      sampleCount: group.length,
      inputDriverKinds: [...new Set(group.map((sample) => sample.runner.inputDriver.kind))],
      inputEvidence: {
        actualCommandDurationMedianMs: median(
          values((sample) => sample.runner.inputDriver.actualCommandDurationMs),
        ),
        achievedIntentHzMedian: median(values((sample) => sample.page.metrics.achievedIntentHz)),
        wheelEventCountMedian: median(values((sample) => sample.page.metrics.wheelEventCount)),
        allObservedWheelEventsTrusted: group.every(
          (sample) =>
            sample.page.metrics.wheelEventCount === 0 ||
            sample.page.metrics.allObservedWheelEventsTrusted === true,
        ),
      },
      freshProcessMedians: {
        intentToPublicationMedianMs: median(
          values((sample) => sample.page.metrics.intentToPublicationMs.median),
        ),
        intentToPublicationP95Ms: median(
          values((sample) => sample.page.metrics.intentToPublicationMs.p95),
        ),
        interPresentationP95Ms: median(
          values((sample) => sample.page.metrics.interPresentationMs.p95),
        ),
        rafIntervalP95Ms: median(values((sample) => sample.page.metrics.rafIntervalMs.p95)),
        finalSettleMs: median(values((sample) => sample.page.trace.finalSettleMs)),
        maximumTransientAbsoluteDriftPx: median(
          values((sample) => sample.page.metrics.maximumVisibleGeometryDriftPx),
        ),
      },
      allCorrect: group.length > 0 && group.every((sample) => sample.page.correctness.passed),
    };
  });
}

function parseArguments(arguments_) {
  const parsed = {
    scenarios: [...SCENARIOS],
    rowScale: 1,
    repetitions: 3,
    durationMs: 5_000,
    cadenceHz: 60,
    settleMs: 100,
    browser: "chromium",
    dpr: 1,
    headed: false,
    timeoutMs: 10 * 60 * 1_000,
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
    else if (argument === "--scenarios") parsed.scenarios = list(arguments_[++index]);
    else if (argument === "--row-scale")
      parsed.rowScale = boundedNumber(arguments_[++index], argument, 0, 1);
    else if (argument === "--repetitions")
      parsed.repetitions = positiveInteger(arguments_[++index], argument);
    else if (argument === "--duration-ms")
      parsed.durationMs = positiveNumber(arguments_[++index], argument);
    else if (argument === "--cadence-hz")
      parsed.cadenceHz = positiveNumber(arguments_[++index], argument);
    else if (argument === "--settle-ms")
      parsed.settleMs = nonNegativeNumber(arguments_[++index], argument);
    else if (argument === "--timeout-ms")
      parsed.timeoutMs = positiveInteger(arguments_[++index], argument);
    else if (argument === "--dpr") parsed.dpr = positiveNumber(arguments_[++index], argument);
    else if (argument === "--browser") parsed.browser = arguments_[++index];
    else if (argument === "--source-root") parsed.sourceRoot = arguments_[++index];
    else if (argument === "--output") parsed.output = arguments_[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  validateList(parsed.scenarios, SCENARIOS, "scenarios");
  if (!Object.hasOwn(browserTypes, parsed.browser)) {
    throw new Error("browser must be chromium, firefox, or webkit.");
  }
  return parsed;
}

function defaultOutputPath(date) {
  const stamp = date
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `artifacts/benchmarks/grid/grid-interaction-v2-${stamp}.json`;
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(targetMs) {
  const remaining = targetMs - performance.now();
  if (remaining > 0) await waitMilliseconds(remaining);
}

function usage() {
  return `Sixtyfold Grid interaction pipeline benchmark

Usage:
  pnpm benchmark:grid -- interaction [options]

Each scenario launches a fresh browser process and drives the real worker-mode Grid.

Options:
  --scenarios LIST       vertical-wheel,compressed-thumb,horizontal-wheel,resize-drag
  --row-scale N          debug scale in (0,1]; only 1 is gate evidence
  --repetitions N        fresh processes per scenario (default: 3)
  --duration-ms N        trace duration (default: 5000)
  --cadence-hz N         input cadence (default: 60)
  --settle-ms N          post-publication settle window (default: 100)
  --browser NAME         chromium, firefox, or webkit
  --dpr N                emulated device pixel ratio (default: 1)
  --source-root PATH     repository or packages/grid subject tree
  --output PATH          raw JSON artifact path
  --headed               show browser
  --timeout-ms N         per-sample timeout
  --no-enforce           write harness correctness failures without exiting non-zero
  --quiet                suppress artifact JSON on stdout
  --verbose              show Vite output
  --help                 show this help
`;
}
