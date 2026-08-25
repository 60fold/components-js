#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { build as viteBuild } from "vite";
import {
  boundedNumber,
  browserDistribution,
  captureOutcome,
  createStaticServer,
  git,
  hashCanonicalTree,
  isNumber,
  list,
  maximum,
  median,
  nonNegativeNumber,
  outcomeFailure,
  percentile,
  positiveInteger,
  positiveNumber,
  resolveGridPackageRoot,
  validateList,
} from "./benchmark-grid-runner-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);
const playwrightVersion = requireFromHere("@playwright/test/package.json").version;
const browserTypes = { chromium, firefox, webkit };
const safariDriverPath = "/usr/bin/safaridriver";
const safariApplicationPath = "/Applications/Safari.app";
const defaultGeckoDriverPath = process.env.SIXTYFOLD_GECKODRIVER_PATH ?? "geckodriver";
const defaultFirefoxApplicationPath =
  process.env.SIXTYFOLD_FIREFOX_APPLICATION_PATH ??
  "/Applications/Firefox.app/Contents/MacOS/firefox";
const P95_MINIMUM_INDEPENDENT_SAMPLES = 20;
const LIFECYCLE_THRESHOLDS = Object.freeze({
  steadyAttributableBytesPerInputByteMaximum: 1.25,
  firstTypedSortPeakBytesPerInputByteMaximum: 1.5,
  sameSizeReplacementPeakBytesPerInputByteMaximum: 2.25,
  postReleaseResidualBytesMaximum: Object.freeze({
    fixedBytes: 64 * 1_024 * 1_024,
    inputFraction: 0.1,
    formula: "max(fixedBytes, inputTypedArrayBytes * inputFraction)",
  }),
  initialSetDataSettledMsMaximum: 1_000,
  replacementSetDataSettledMsMaximum: 1_000,
  maximumWorkerHeartbeatDelayMsMaximum: 200,
  initialViewportCallbackMsMaximum: 1_000,
  immediateSortedSurfaceMsMaximum: Object.freeze({ "narrow-10m": 2_500, "wide-1m": 1_000 }),
  firstSortNonBuilderOverheadMsMaximum: 100,
  destroyWorkerTargetDisappearanceMsMaximum: 250,
  correctnessAndWorkerPathRequired: true,
});
const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (options.passes.includes("memory") && options.browser !== "chromium") {
  throw new Error("The memory pass requires Chromium for UA-specific memory and CDP process data.");
}

const gridPackageRoot = await resolveGridPackageRoot(path.resolve(root, options.sourceRoot));
const resolvedGridPackageRoot = await realpath(gridPackageRoot);
const currentGridPackageRoot = await realpath(path.join(root, "packages/grid")).catch(() => null);
const usesExternalSubject =
  currentGridPackageRoot === null || resolvedGridPackageRoot !== currentGridPackageRoot;
const startedAt = new Date();
const provenance = {
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
      root: path.join(root, "benchmarks/grid-lifecycle/index.html"),
      prefix: "benchmarks/grid-lifecycle/index.html",
    },
    {
      root: path.join(root, "benchmarks/grid-lifecycle/src"),
      prefix: "benchmarks/grid-lifecycle/src",
    },
    {
      root: path.join(root, "scripts/benchmark-grid-lifecycle.mjs"),
      prefix: "scripts/benchmark-grid-lifecycle.mjs",
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

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sixtyfold-grid-lifecycle-"));
const siteRoot = path.join(temporaryRoot, "site");
let server;
try {
  await viteBuild({
    configFile: false,
    root: path.join(root, "benchmarks/grid-lifecycle"),
    publicDir: false,
    logLevel: options.verbose ? "info" : "warn",
    resolve: {
      alias: {
        "@grid-benchmark/types": path.join(gridPackageRoot, "src/types.ts"),
        "@grid-lifecycle/grid": path.join(gridPackageRoot, "src/index.ts"),
        "@grid-lifecycle/profiles": path.join(root, "benchmarks/grid/src/profiles.ts"),
      },
    },
    build: {
      outDir: siteRoot,
      emptyOutDir: true,
      target: ["chrome100", "firefox100", "safari16"],
      rollupOptions: { input: path.join(root, "benchmarks/grid-lifecycle/index.html") },
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
  let capturedBrowserVersion = null;
  let capturedDevicePixelRatio = null;
  let capturedViewport = null;
  for (const ownership of options.ownerships) {
    for (const rowIdMode of options.rowIdModes) {
      for (const profile of options.profiles) {
        for (const pass of options.passes) {
          const repetitions =
            pass === "latency" ? options.latencyRepetitions : options.memoryRepetitions;
          for (let sampleIndex = 0; sampleIndex < repetitions; sampleIndex++) {
            const identity = { ownership, rowIdMode, profile, pass, sampleIndex };
            const attempt = await captureOutcome(
              outcomes,
              { ...identity, timeoutMs: options.timeoutMs },
              () => runSample({ ...identity, port: address.port }),
            );
            if (attempt.ok) {
              const sample = attempt.value;
              capturedBrowserVersion ??= sample.runner.browserVersion;
              capturedDevicePixelRatio ??= sample.page.browser.devicePixelRatio;
              capturedViewport ??= sample.page.browser.viewport;
              samples.push(sample);
            } else {
              const label = `${ownership}/${rowIdMode}/${profile}/${pass}/${sampleIndex}`;
              attemptFailures.push(outcomeFailure(label, attempt));
              process.stderr.write(`[grid lifecycle] ${label}: ${attempt.status}\n`);
            }
          }
        }
      }
    }
  }

  const displayEvidence = {
    consistentAcrossSamples:
      samples.length > 0 &&
      samples.every(
        (sample) =>
          sample.page.browser.devicePixelRatio === capturedDevicePixelRatio &&
          sample.page.browser.viewport.width === capturedViewport.width &&
          sample.page.browser.viewport.height === capturedViewport.height,
      ),
  };
  const failures = [
    ...attemptFailures,
    ...samples.flatMap((sample) =>
      [
        ...sample.page.failures,
        ...sample.runner.browserErrors.map((error) => `browser error: ${error}`),
        ...(isInstalledWebDriverBrowser(options.browser)
          ? sample.page.workerTracking.constructed === 0
            ? ["in-page Worker instrumentation observed no Grid workers."]
            : sample.page.workerTracking.activeAfterDestroy !== 0
              ? [
                  `${sample.page.workerTracking.activeAfterDestroy} instrumented Grid worker(s) had not received terminate() after destroy.`,
                ]
              : []
          : sample.runner.portableWorkerLifecycle.status !== "available"
            ? ["portable Playwright worker lifecycle tracking was unavailable."]
            : sample.runner.portableWorkerLifecycle.gridWorkerCount === 0
              ? ["portable Playwright worker lifecycle tracking observed no Grid workers."]
              : sample.runner.portableWorkerLifecycle.allGridWorkersDestroyed !== true
                ? [
                    `${sample.runner.workersAfterDestroy} portable Playwright Grid worker(s) remained after destroy.`,
                  ]
                : []),
      ].map(
        (failure) =>
          `${sample.page.configuration.ownership}/${sample.page.configuration.rowIdMode}/${sample.page.configuration.profile}/${sample.page.configuration.pass}/${sample.page.configuration.sampleIndex}: ${failure}`,
      ),
    ),
  ];
  if (isInstalledWebDriverBrowser(options.browser) && !displayEvidence.consistentAcrossSamples) {
    failures.push(
      `${installedBrowserLabel(options.browser)} actual devicePixelRatio or inner viewport changed between samples.`,
    );
  }
  const lifecycleQualification = buildLifecycleQualification(samples, options);
  const portableLatencyQualification = buildPortableLatencyQualification(samples, options);
  const genuineSafariLatencyObservation = buildGenuineSafariLatencyObservation(samples, options);
  const genuineFirefoxLatencyObservation = buildGenuineFirefoxLatencyObservation(samples, options);
  const subjectGitStatus = git(gridPackageRoot, ["status", "--short", "--", "."]);
  const artifact = {
    schemaVersion: 4,
    benchmark: "sixtyfold-grid-production-lifecycle",
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
      ownerships: options.ownerships,
      rowIdModes: options.rowIdModes,
      passes: options.passes,
      rowScale: options.rowScale,
      latencyRepetitions: options.latencyRepetitions,
      memoryRepetitions: options.memoryRepetitions,
      postDestroySettleMs: options.postDestroySettleMs,
      timeoutMs: options.timeoutMs,
      headed: options.headed,
      freshBrowserProcessPerSample: options.browser === "safari" ? null : true,
      freshAutomationSessionPerSample: true,
      freshDriverProcessPerSample: isInstalledWebDriverBrowser(options.browser) ? true : null,
      lifecycleSemantics: {
        initial: "cold Grid with paint and canonical runtime workers; no prior dataset",
        sort: "first full numeric sort immediately after the renderer-confirmed raw surface",
        replacement:
          "warm initialized Grid receiving a newly generated same-shape and same-byte-size dataset",
        destroy:
          "synchronous Grid.destroy followed by caller reference release and settling samples",
      },
    },
    environment: {
      capturedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      browser: options.browser,
      browserVersion: capturedBrowserVersion,
      automation: automationMetadata(options.browser, capturedBrowserVersion),
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      v8: process.versions.v8,
      v8FieldMeaning: "Node.js runner V8 version; not the selected browser JavaScript engine",
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalSystemMemoryBytes: os.totalmem(),
      freeSystemMemoryAtCompletionBytes: os.freemem(),
      requestedDevicePixelRatio: isInstalledWebDriverBrowser(options.browser) ? null : options.dpr,
      devicePixelRatio: capturedDevicePixelRatio ?? options.dpr,
      viewport: capturedViewport ?? { width: 1_280, height: 720 },
      displayEvidence,
    },
    lifecycleQualification,
    portableLatencyQualification,
    genuineSafariLatencyObservation,
    genuineFirefoxLatencyObservation,
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
  process.stderr.write(`[grid lifecycle] raw artifact: ${outputPath}\n`);
  process.stderr.write(`[grid lifecycle] regression result: ${lifecycleQualification.decision}\n`);
  process.stderr.write(
    `[grid lifecycle] portable latency decision: ${portableLatencyQualification.decision}\n`,
  );
  if (genuineSafariLatencyObservation) {
    process.stderr.write(
      `[grid lifecycle] genuine Safari observation: ${genuineSafariLatencyObservation.decision}\n`,
    );
  }
  if (genuineFirefoxLatencyObservation) {
    process.stderr.write(
      `[grid lifecycle] genuine Firefox observation: ${genuineFirefoxLatencyObservation.decision}\n`,
    );
  }
  if (options.enforce && failures.length > 0) {
    throw new Error(`Grid lifecycle harness failed:\n- ${failures.join("\n- ")}`);
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runSample({ ownership, rowIdMode, profile, pass, sampleIndex, port }) {
  if (options.browser === "safari") {
    return runSafariSample({ ownership, rowIdMode, profile, pass, sampleIndex, port });
  }
  if (options.browser === "firefox-installed") {
    return runInstalledFirefoxSample({ ownership, rowIdMode, profile, pass, sampleIndex, port });
  }
  const browserType = browserTypes[options.browser];
  if (!browserType) throw new Error(`Unsupported browser ${JSON.stringify(options.browser)}.`);
  const launchArgs = [];
  if (options.browser === "chromium") launchArgs.push("--enable-precise-memory-info");
  if (options.browser === "chromium" && pass === "memory") {
    launchArgs.push("--enable-blink-features=ForceEagerMeasureMemory");
  }
  const browser = await browserType.launch({
    headless: !options.headed,
    ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
  });
  const browserVersion = browser.version();
  let cdp = null;
  let rssSampler = notSampledRss(pass);
  let workerTargetTracker = unavailableWorkerTargetTracker();
  let portableWorkerTracker = unavailablePortableWorkerTracker();
  let context;
  let page;
  try {
    if (options.browser === "chromium") {
      cdp = await browser.newBrowserCDPSession();
      workerTargetTracker = await createWorkerTargetTracker(cdp, port);
    }
    let currentStage = "browser-launched";
    rssSampler = await createRssSampler(cdp, pass, () => currentStage);
    await rssSampler.sampleNow();

    context = await browser.newContext({
      viewport: { width: 1_280, height: 720 },
      deviceScaleFactor: options.dpr,
    });
    page = await context.newPage();
    portableWorkerTracker = createPortableWorkerTracker(page);
    const browserErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`[console] ${message.text()}`);
    });
    page.on("pageerror", (error) => browserErrors.push(`[page] ${error.stack ?? error.message}`));
    page.on("response", (response) => {
      if (response.status() >= 400)
        browserErrors.push(`[http ${response.status()}] ${response.url()}`);
    });

    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set("profile", profile);
    url.searchParams.set("ownership", ownership);
    url.searchParams.set("rowIdMode", rowIdMode);
    url.searchParams.set("pass", pass);
    url.searchParams.set("rowScale", String(options.rowScale));
    url.searchParams.set("sampleIndex", String(sampleIndex));
    url.searchParams.set("postDestroySettleMs", String(options.postDestroySettleMs));
    const label = `${ownership}/${rowIdMode}/${profile}/${pass}/${sampleIndex + 1}`;
    process.stderr.write(`[grid lifecycle] ${label}: loading fresh browser process\n`);
    await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });

    let lastLoggedStage = "";
    const stagePoller = setInterval(async () => {
      const stage = await page
        .evaluate(() => globalThis.__SIXTYFOLD_GRID_LIFECYCLE_STAGE__ ?? "not-started")
        .catch(() => "page-unavailable");
      currentStage = stage;
      if (stage !== lastLoggedStage) {
        process.stderr.write(`[grid lifecycle] ${label}: ${stage}\n`);
        lastLoggedStage = stage;
      }
    }, 500);
    rssSampler.start();
    try {
      await page.waitForFunction(
        () => globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__ !== undefined,
        undefined,
        { timeout: options.timeoutMs },
      );
    } catch (error) {
      const stage = await page
        .evaluate(() => globalThis.__SIXTYFOLD_GRID_LIFECYCLE_STAGE__ ?? "not-started")
        .catch(() => "page-unavailable");
      throw new Error(`${label} stalled at ${stage}.`, { cause: error });
    } finally {
      clearInterval(stagePoller);
      await rssSampler.stop();
    }
    const result = await page.evaluate(() => globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__);
    if (result?.error) throw new Error(`${label}: ${result.error}`);
    await rssSampler.sampleNow();
    const workerTargetLifecycle = workerTargetTracker.result(
      result.timings.destroyStartedAtEpochMs,
    );
    const workerTargetsAfterDestroy = workerTargetLifecycle.activeGridWorkerTargets;
    const portableWorkerLifecycle = portableWorkerTracker.result(
      result.timings.destroyStartedAtEpochMs,
    );
    const workersAfterDestroy = portableWorkerLifecycle.activeGridWorkers;
    const runner = {
      browserVersion,
      browserErrors,
      workersAfterDestroy,
      portableWorkerLifecycle,
      workerTargetsAfterDestroy,
      workerTargetLifecycle,
      processRss: rssSampler.result(),
    };
    process.stderr.write(
      `[grid lifecycle] ${label}: ${result.failures.length === 0 ? "passed" : `${result.failures.length} failure(s)`}\n`,
    );
    return { page: result, runner };
  } finally {
    await rssSampler.stop().catch(() => undefined);
    await portableWorkerTracker.dispose().catch(() => undefined);
    await workerTargetTracker.dispose().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
    await browser.close();
  }
}

async function runSafariSample({ ownership, rowIdMode, profile, pass, sampleIndex, port }) {
  if (pass !== "latency") throw new Error("Genuine Safari supports latency passes only.");
  const driverPort = await reserveLoopbackPort();
  const driver = spawn(safariDriverPath, ["--port", String(driverPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let driverOutput = "";
  const captureDriverOutput = (chunk) => {
    driverOutput = `${driverOutput}${String(chunk)}`.slice(-16_384);
  };
  driver.stdout.on("data", captureDriverOutput);
  driver.stderr.on("data", captureDriverOutput);
  let sessionId = null;
  try {
    await waitForSafariDriver(driverPort, driver, () => driverOutput);
    const session = await safariDriverRequest(driverPort, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          "safari:automaticInspection": false,
          "safari:automaticProfiling": false,
        },
      },
    });
    sessionId = session.sessionId;
    if (!sessionId) throw new Error("safaridriver returned no WebDriver session id.");
    const capabilities = session.capabilities ?? {};
    const browserVersion = String(capabilities.browserVersion ?? "unknown");
    await sizeSafariViewport(driverPort, sessionId, 1_280, 720);

    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set("profile", profile);
    url.searchParams.set("ownership", ownership);
    url.searchParams.set("rowIdMode", rowIdMode);
    url.searchParams.set("pass", pass);
    url.searchParams.set("rowScale", String(options.rowScale));
    url.searchParams.set("sampleIndex", String(sampleIndex));
    url.searchParams.set("postDestroySettleMs", String(options.postDestroySettleMs));
    const label = `${ownership}/${rowIdMode}/${profile}/${pass}/${sampleIndex + 1}`;
    process.stderr.write(`[grid lifecycle] ${label}: loading fresh Safari WebDriver session\n`);
    await safariDriverRequest(driverPort, "POST", `/session/${encodeURIComponent(sessionId)}/url`, {
      url: url.href,
    });

    const startedWaitingAt = Date.now();
    let lastLoggedStage = "";
    let state;
    while (Date.now() - startedWaitingAt <= options.timeoutMs) {
      state = await safariExecute(
        driverPort,
        sessionId,
        `
        return {
          stage: globalThis.__SIXTYFOLD_GRID_LIFECYCLE_STAGE__ || "not-started",
          complete: globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__ !== undefined
        };
      `,
      );
      const stage = state?.stage ?? "not-started";
      if (stage !== lastLoggedStage) {
        process.stderr.write(`[grid lifecycle] ${label}: ${stage}\n`);
        lastLoggedStage = stage;
      }
      if (state?.complete === true) break;
      await waitMilliseconds(500);
    }
    if (state?.complete !== true) {
      throw new Error(`${label} stalled at ${state?.stage ?? "not-started"}.`);
    }
    const result = await safariExecute(
      driverPort,
      sessionId,
      "return globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__;",
    );
    if (result?.error) throw new Error(`${label}: ${result.error}`);
    const workersAfterDestroy = result.workerTracking.activeAfterDestroy;
    const runner = {
      browserVersion,
      browserErrors: [],
      browserErrorCapture: {
        status: "page-instrumented-only",
        source:
          "in-page error and unhandledrejection listeners; safaridriver exposes no equivalent of Playwright console/pageerror/response events",
        caveat:
          "An empty runner.browserErrors array is not an independent Safari console-clean assertion. Page runtime failures are recorded in page.failures; navigation and WebDriver protocol failures reject the sample.",
      },
      workersAfterDestroy,
      portableWorkerLifecycle: unavailableSafariWorkerLifecycle(result.workerTracking),
      workerTargetsAfterDestroy: null,
      workerTargetLifecycle: unavailableSafariWorkerTargetTracker(),
      processRss: notSampledRss(pass).result(),
      webdriver: {
        freshSession: true,
        freshDriverProcess: true,
      },
    };
    process.stderr.write(
      `[grid lifecycle] ${label}: ${result.failures.length === 0 ? "passed" : `${result.failures.length} failure(s)`}\n`,
    );
    return { page: result, runner };
  } finally {
    if (sessionId) {
      await safariDriverRequest(
        driverPort,
        "DELETE",
        `/session/${encodeURIComponent(sessionId)}`,
      ).catch(() => undefined);
    }
    await stopChildProcess(driver);
  }
}

async function runInstalledFirefoxSample({
  ownership,
  rowIdMode,
  profile,
  pass,
  sampleIndex,
  port,
}) {
  if (pass !== "latency") throw new Error("Genuine Firefox supports latency passes only.");
  const driverPort = await reserveLoopbackPort();
  const driver = spawn(
    options.geckoDriverPath,
    ["--host", "127.0.0.1", "--port", String(driverPort)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let driverOutput = "";
  const captureDriverOutput = (chunk) => {
    driverOutput = `${driverOutput}${String(chunk)}`.slice(-16_384);
  };
  let driverSpawnError = null;
  driver.stdout.on("data", captureDriverOutput);
  driver.stderr.on("data", captureDriverOutput);
  driver.on("error", (error) => {
    driverSpawnError = error;
    captureDriverOutput(error.stack ?? error.message);
  });
  let sessionId = null;
  try {
    await waitForGeckoDriver(
      driverPort,
      driver,
      () => driverOutput,
      () => driverSpawnError,
    );
    const session = await geckoDriverRequest(driverPort, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary: options.firefoxApplicationPath,
          },
        },
      },
    });
    sessionId = session.sessionId;
    if (!sessionId) throw new Error("geckodriver returned no WebDriver session id.");
    const capabilities = session.capabilities ?? {};
    const browserVersion = String(capabilities.browserVersion ?? "unknown");
    const browserProcessId = Number.isInteger(capabilities["moz:processID"])
      ? capabilities["moz:processID"]
      : null;
    if (browserProcessId === null) {
      throw new Error("geckodriver did not report the launched Firefox moz:processID capability.");
    }
    await sizeFirefoxViewport(driverPort, sessionId, 1_280, 720);

    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set("profile", profile);
    url.searchParams.set("ownership", ownership);
    url.searchParams.set("rowIdMode", rowIdMode);
    url.searchParams.set("pass", pass);
    url.searchParams.set("rowScale", String(options.rowScale));
    url.searchParams.set("sampleIndex", String(sampleIndex));
    url.searchParams.set("postDestroySettleMs", String(options.postDestroySettleMs));
    const label = `${ownership}/${rowIdMode}/${profile}/${pass}/${sampleIndex + 1}`;
    process.stderr.write(
      `[grid lifecycle] ${label}: loading fresh installed-Firefox WebDriver session\n`,
    );
    await geckoDriverRequest(driverPort, "POST", `/session/${encodeURIComponent(sessionId)}/url`, {
      url: url.href,
    });

    const startedWaitingAt = Date.now();
    let lastLoggedStage = "";
    let state;
    while (Date.now() - startedWaitingAt <= options.timeoutMs) {
      state = await firefoxExecute(
        driverPort,
        sessionId,
        `
        return {
          stage: globalThis.__SIXTYFOLD_GRID_LIFECYCLE_STAGE__ || "not-started",
          complete: globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__ !== undefined
        };
      `,
      );
      const stage = state?.stage ?? "not-started";
      if (stage !== lastLoggedStage) {
        process.stderr.write(`[grid lifecycle] ${label}: ${stage}\n`);
        lastLoggedStage = stage;
      }
      if (state?.complete === true) break;
      await waitMilliseconds(500);
    }
    if (state?.complete !== true) {
      throw new Error(`${label} stalled at ${state?.stage ?? "not-started"}.`);
    }
    const result = await firefoxExecute(
      driverPort,
      sessionId,
      "return globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__;",
    );
    if (result?.error) throw new Error(`${label}: ${result.error}`);
    const workersAfterDestroy = result.workerTracking.activeAfterDestroy;
    const runner = {
      browserVersion,
      browserErrors: [],
      browserErrorCapture: {
        status: "page-instrumented-only",
        source:
          "in-page error and unhandledrejection listeners; WebDriver Classic exposes no Playwright-equivalent console/pageerror/response event stream",
        caveat:
          "An empty runner.browserErrors array is not an independent Firefox console-clean assertion. Page runtime and resource failures are recorded in page.failures; navigation and WebDriver protocol failures reject the sample.",
      },
      workersAfterDestroy,
      portableWorkerLifecycle: unavailableFirefoxWorkerLifecycle(result.workerTracking),
      workerTargetsAfterDestroy: null,
      workerTargetLifecycle: unavailableFirefoxWorkerTargetTracker(),
      processRss: notSampledRss(pass).result(),
      webdriver: {
        freshSession: true,
        freshDriverProcess: true,
        launchedBrowserProcessId: browserProcessId,
        launchedBrowserProcessIdSource: "moz:processID WebDriver capability",
        driverProcessId: driver.pid ?? null,
      },
    };
    process.stderr.write(
      `[grid lifecycle] ${label}: ${result.failures.length === 0 ? "passed" : `${result.failures.length} failure(s)`}\n`,
    );
    return { page: result, runner };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const driverTail = driverOutput.trim();
    throw new Error(
      driverTail.length > 0 ? `${message}\nGeckodriver output tail:\n${driverTail}` : message,
      { cause: error },
    );
  } finally {
    if (sessionId) {
      await geckoDriverRequest(
        driverPort,
        "DELETE",
        `/session/${encodeURIComponent(sessionId)}`,
      ).catch(() => undefined);
    }
    await stopChildProcess(driver);
  }
}

async function sizeSafariViewport(port, sessionId, width, height) {
  const endpoint = `/session/${encodeURIComponent(sessionId)}/window/rect`;
  await safariDriverRequest(port, "POST", endpoint, { width, height });
  for (let attempt = 0; attempt < 2; attempt++) {
    const dimensions = await safariExecute(
      port,
      sessionId,
      "return {innerWidth, innerHeight, outerWidth, outerHeight};",
    );
    if (dimensions.innerWidth === width && dimensions.innerHeight === height) return;
    const chromeWidth = Math.max(0, dimensions.outerWidth - dimensions.innerWidth);
    const chromeHeight = Math.max(0, dimensions.outerHeight - dimensions.innerHeight);
    await safariDriverRequest(port, "POST", endpoint, {
      width: width + chromeWidth,
      height: height + chromeHeight,
    });
  }
}

async function sizeFirefoxViewport(port, sessionId, width, height) {
  const endpoint = `/session/${encodeURIComponent(sessionId)}/window/rect`;
  await geckoDriverRequest(port, "POST", endpoint, { width, height });
  for (let attempt = 0; attempt < 2; attempt++) {
    const dimensions = await firefoxExecute(
      port,
      sessionId,
      "return {innerWidth, innerHeight, outerWidth, outerHeight};",
    );
    if (dimensions.innerWidth === width && dimensions.innerHeight === height) return;
    const chromeWidth = Math.max(0, dimensions.outerWidth - dimensions.innerWidth);
    const chromeHeight = Math.max(0, dimensions.outerHeight - dimensions.innerHeight);
    await geckoDriverRequest(port, "POST", endpoint, {
      width: width + chromeWidth,
      height: height + chromeHeight,
    });
  }
}

async function reserveLoopbackPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Port probe returned no port.");
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForSafariDriver(port, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `safaridriver exited ${child.exitCode} before accepting a session. ${output().trim()}`,
      );
    }
    try {
      await safariDriverRequest(port, "GET", "/status");
      return;
    } catch {
      await waitMilliseconds(100);
    }
  }
  throw new Error(`Timed out waiting for safaridriver. ${output().trim()}`);
}

async function waitForGeckoDriver(port, child, output, spawnError) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError()) {
      throw new Error(`Unable to launch geckodriver. ${output().trim()}`);
    }
    if (child.exitCode !== null) {
      throw new Error(
        `geckodriver exited ${child.exitCode} before accepting a session. ${output().trim()}`,
      );
    }
    try {
      await geckoDriverRequest(port, "GET", "/status");
      return;
    } catch {
      await waitMilliseconds(100);
    }
  }
  throw new Error(`Timed out waiting for geckodriver. ${output().trim()}`);
}

async function safariDriverRequest(port, method, pathname, body) {
  const request =
    body === undefined
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, request);
  const text = await response.text();
  let payload;
  try {
    payload = text.length === 0 ? { value: null } : JSON.parse(text);
  } catch {
    throw new Error(`safaridriver returned non-JSON HTTP ${response.status}: ${text}`);
  }
  const value = payload?.value;
  if (!response.ok || value?.error) {
    throw new Error(
      `safaridriver ${method} ${pathname} failed (${response.status}): ${value?.message ?? text}`,
    );
  }
  return value;
}

async function geckoDriverRequest(port, method, pathname, body) {
  const request =
    body === undefined
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, request);
  const responseText = await response.text();
  let payload;
  try {
    payload = responseText.length === 0 ? { value: null } : JSON.parse(responseText);
  } catch {
    throw new Error(`geckodriver returned non-JSON HTTP ${response.status}: ${responseText}`);
  }
  const value = payload?.value;
  if (!response.ok || value?.error) {
    throw new Error(
      `geckodriver ${method} ${pathname} failed (${response.status}): ${value?.message ?? responseText}`,
    );
  }
  return value;
}

async function safariExecute(port, sessionId, script) {
  return safariDriverRequest(
    port,
    "POST",
    `/session/${encodeURIComponent(sessionId)}/execute/sync`,
    { script, args: [] },
  );
}

async function firefoxExecute(port, sessionId, script) {
  return geckoDriverRequest(
    port,
    "POST",
    `/session/${encodeURIComponent(sessionId)}/execute/sync`,
    { script, args: [] },
  );
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await Promise.race([closed, waitMilliseconds(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

function unavailableSafariWorkerLifecycle(workerTracking) {
  return {
    status: "unavailable",
    source: null,
    observedWorkerCount: null,
    observedWorkerUrls: [],
    gridWorkerCount: null,
    activeGridWorkers: null,
    allGridWorkersDestroyed: null,
    lastGridWorkerDisappearanceAfterDestroyMs: null,
    gridWorkers: [],
    inPageInstrumentation: {
      constructed: workerTracking.constructed,
      terminateCalls: workerTracking.terminateCalls,
      activeAfterDestroy: workerTracking.activeAfterDestroy,
      urls: workerTracking.urls,
    },
    caveat:
      "safaridriver exposes no dedicated-worker close events or final worker snapshot. In-page instrumentation proves Worker construction and terminate() calls only; it is not native worker-disappearance evidence.",
  };
}

function unavailableFirefoxWorkerLifecycle(workerTracking) {
  return {
    status: "unavailable",
    source: null,
    observedWorkerCount: null,
    observedWorkerUrls: [],
    gridWorkerCount: null,
    activeGridWorkers: null,
    allGridWorkersDestroyed: null,
    lastGridWorkerDisappearanceAfterDestroyMs: null,
    gridWorkers: [],
    inPageInstrumentation: {
      constructed: workerTracking.constructed,
      terminateCalls: workerTracking.terminateCalls,
      activeAfterDestroy: workerTracking.activeAfterDestroy,
      urls: workerTracking.urls,
    },
    caveat:
      "geckodriver WebDriver Classic exposes no dedicated-worker close events or final worker snapshot. In-page instrumentation proves Worker construction and terminate() calls only; it is not native worker-disappearance evidence.",
  };
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unavailableSafariWorkerTargetTracker() {
  const unavailable = unavailableWorkerTargetTracker().result();
  return {
    ...unavailable,
    caveat:
      "Safari WebDriver exposes no CDP Target discovery or equivalent native dedicated-worker lifecycle API.",
  };
}

function unavailableFirefoxWorkerTargetTracker() {
  const unavailable = unavailableWorkerTargetTracker().result();
  return {
    ...unavailable,
    caveat:
      "Firefox WebDriver Classic exposes no CDP Target discovery or equivalent native dedicated-worker lifecycle API.",
  };
}

async function createRssSampler(cdp, pass, currentStage) {
  if (pass !== "memory") return notSampledRss(pass);
  if (!cdp) return unavailableRss("A Chromium browser CDP session was unavailable.");
  const samples = [];
  const errors = [];
  let timer = null;
  let inFlight = false;
  const sampleNow = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const processes = processInfo
        .map((entry) => ({ pid: Number(entry.id), type: entry.type }))
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
      if (processes.length === 0) throw new Error("CDP reported no browser processes.");
      const ps = spawnSync(
        "ps",
        ["-o", "pid=,rss=", "-p", processes.map((entry) => entry.pid).join(",")],
        { encoding: "utf8" },
      );
      if (ps.status !== 0) throw new Error(ps.stderr.trim() || `ps exited ${ps.status}`);
      const rssByPid = new Map();
      for (const line of ps.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (match) rssByPid.set(Number(match[1]), Number(match[2]) * 1_024);
      }
      const entries = processes
        .map((entry) => ({ ...entry, rssBytes: rssByPid.get(entry.pid) ?? null }))
        .filter((entry) => entry.rssBytes !== null);
      if (entries.length === 0) throw new Error("ps returned no RSS for CDP browser processes.");
      samples.push({
        observedAtEpochMs: Date.now(),
        stage: currentStage(),
        totalRssBytes: entries.reduce((total, entry) => total + entry.rssBytes, 0),
        processCount: entries.length,
        processes: entries,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!errors.includes(message)) errors.push(message);
    } finally {
      inFlight = false;
    }
  };
  return {
    start() {
      if (!timer) timer = setInterval(() => void sampleNow(), options.rssIntervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      while (inFlight) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    sampleNow,
    result() {
      const values = samples.map((sample) => sample.totalRssBytes);
      const baselineRssBytes = values[0] ?? null;
      const peakRssBytes = values.length > 0 ? Math.max(...values) : null;
      return {
        status: samples.length > 0 ? "available" : "unavailable",
        source: "Chromium SystemInfo.getProcessInfo PID set sampled with operating-system ps RSS",
        samplingIntervalMs: options.rssIntervalMs,
        baselineRssBytes,
        peakRssBytes,
        peakDeltaFromBaselineBytes:
          baselineRssBytes === null || peakRssBytes === null
            ? null
            : peakRssBytes - baselineRssBytes,
        samples,
        errors,
        caveat:
          "Advisory browser-process-set RSS, not an allocation ledger. Samples are asynchronous, include Chromium infrastructure, may miss short peaks, and process membership can change between CDP and ps snapshots.",
      };
    },
  };
}

function notSampledRss(pass) {
  return {
    start() {},
    async stop() {},
    async sampleNow() {},
    result() {
      return {
        status: pass === "memory" ? "unavailable" : "not-sampled",
        source: null,
        samplingIntervalMs: null,
        baselineRssBytes: null,
        peakRssBytes: null,
        peakDeltaFromBaselineBytes: null,
        samples: [],
        errors: [],
        caveat:
          pass === "memory"
            ? "The external Chromium process sampler was unavailable."
            : "RSS sampling is disabled in latency passes to avoid perturbing timings.",
      };
    },
  };
}

function unavailableRss(reason) {
  const sampler = notSampledRss("memory");
  return {
    ...sampler,
    result() {
      return { ...sampler.result(), errors: [reason] };
    },
  };
}

function createPortableWorkerTracker(page) {
  const workers = new Map();
  const onWorker = (worker) => {
    if (workers.has(worker)) return;
    const record = {
      worker,
      url: worker.url(),
      createdAtEpochMs: Date.now(),
      closedAtEpochMs: null,
      onClose: null,
    };
    record.onClose = () => {
      record.closedAtEpochMs ??= Date.now();
    };
    workers.set(worker, record);
    worker.on("close", record.onClose);
  };
  page.on("worker", onWorker);
  for (const worker of page.workers()) onWorker(worker);
  return {
    result(destroyStartedAtEpochMs) {
      const activeWorkers = new Set(page.workers());
      const observedWorkers = [...workers.values()];
      const gridWorkers = observedWorkers.filter((worker) => isGridWorkerUrl(worker.url));
      const activeGridWorkers = gridWorkers.filter((worker) =>
        activeWorkers.has(worker.worker),
      ).length;
      const destructionOffsets = gridWorkers
        .map((worker) =>
          worker.closedAtEpochMs === null
            ? null
            : Math.max(0, worker.closedAtEpochMs - destroyStartedAtEpochMs),
        )
        .filter(isNumber);
      return {
        status: "available",
        source: "Playwright Page worker and Worker close events with a final page.workers snapshot",
        observedWorkerCount: observedWorkers.length,
        observedWorkerUrls: observedWorkers.map((worker) => worker.url),
        gridWorkerCount: gridWorkers.length,
        activeGridWorkers,
        allGridWorkersDestroyed:
          gridWorkers.length > 0 &&
          activeGridWorkers === 0 &&
          destructionOffsets.length === gridWorkers.length,
        lastGridWorkerDisappearanceAfterDestroyMs:
          destructionOffsets.length === gridWorkers.length ? maximum(destructionOffsets) : null,
        gridWorkers: gridWorkers.map(({ url, createdAtEpochMs, closedAtEpochMs }) => ({
          url,
          createdAtEpochMs,
          closedAtEpochMs,
        })),
        caveat:
          "Playwright event receipt and page performance clocks are aligned through epoch milliseconds. This portable dedicated-worker observation is an upper bound, not an engine-internal termination timestamp; it excludes service workers.",
      };
    },
    async dispose() {
      page.off("worker", onWorker);
      for (const record of workers.values()) record.worker.off("close", record.onClose);
    },
  };
}

function unavailablePortableWorkerTracker() {
  return {
    result() {
      return {
        status: "unavailable",
        source: null,
        observedWorkerCount: null,
        observedWorkerUrls: [],
        gridWorkerCount: null,
        activeGridWorkers: null,
        allGridWorkersDestroyed: null,
        lastGridWorkerDisappearanceAfterDestroyMs: null,
        gridWorkers: [],
        caveat: "Playwright page worker lifecycle tracking was unavailable.",
      };
    },
    async dispose() {},
  };
}

function isGridWorkerUrl(url) {
  return url.includes("grid.paint.worker") || url.includes("grid.runtime.worker");
}

async function createWorkerTargetTracker(cdp, port) {
  const origin = `http://127.0.0.1:${port}/`;
  const workers = new Map();
  const workerTypes = new Set(["worker", "shared_worker", "service_worker"]);
  const recordTarget = (targetInfo) => {
    if (!workerTypes.has(targetInfo.type) || !targetInfo.url.startsWith(origin)) return;
    const existing = workers.get(targetInfo.targetId);
    workers.set(targetInfo.targetId, {
      targetId: targetInfo.targetId,
      url: targetInfo.url,
      type: targetInfo.type,
      createdAtEpochMs: existing?.createdAtEpochMs ?? Date.now(),
      destroyedAtEpochMs: existing?.destroyedAtEpochMs ?? null,
    });
  };
  const onCreated = ({ targetInfo }) => recordTarget(targetInfo);
  const onChanged = ({ targetInfo }) => recordTarget(targetInfo);
  const onDestroyed = ({ targetId }) => {
    const existing = workers.get(targetId);
    if (existing) existing.destroyedAtEpochMs = Date.now();
  };
  cdp.on("Target.targetCreated", onCreated);
  cdp.on("Target.targetInfoChanged", onChanged);
  cdp.on("Target.targetDestroyed", onDestroyed);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const targetInfo of targetInfos) recordTarget(targetInfo);
  return {
    result(destroyStartedAtEpochMs) {
      const gridWorkers = [...workers.values()].filter(
        (worker) =>
          !worker.url.includes("generator.worker") && !worker.url.includes("heartbeat.worker"),
      );
      const activeGridWorkerTargets = gridWorkers.filter(
        (worker) => worker.destroyedAtEpochMs === null,
      ).length;
      const destructionOffsets = gridWorkers
        .map((worker) =>
          worker.destroyedAtEpochMs === null
            ? null
            : Math.max(0, worker.destroyedAtEpochMs - destroyStartedAtEpochMs),
        )
        .filter(isNumber);
      return {
        status: "available",
        source: "Chromium Target discovery create/destroy events",
        gridWorkerTargetCount: gridWorkers.length,
        activeGridWorkerTargets,
        allGridWorkerTargetsDestroyed: gridWorkers.length > 0 && activeGridWorkerTargets === 0,
        lastGridWorkerDisappearanceAfterDestroyMs:
          destructionOffsets.length === gridWorkers.length ? maximum(destructionOffsets) : null,
        gridWorkers,
        caveat:
          "CDP event receipt and page performance clocks are aligned through epoch milliseconds; scheduling and millisecond clock resolution make this an upper-bound observation, not an engine-internal termination timestamp.",
      };
    },
    async dispose() {
      cdp.off("Target.targetCreated", onCreated);
      cdp.off("Target.targetInfoChanged", onChanged);
      cdp.off("Target.targetDestroyed", onDestroyed);
      await cdp.send("Target.setDiscoverTargets", { discover: false }).catch(() => undefined);
    },
  };
}

function unavailableWorkerTargetTracker() {
  return {
    result() {
      return {
        status: "unavailable",
        source: null,
        gridWorkerTargetCount: null,
        activeGridWorkerTargets: null,
        allGridWorkerTargetsDestroyed: null,
        lastGridWorkerDisappearanceAfterDestroyMs: null,
        gridWorkers: [],
        caveat: "Chromium Target discovery was unavailable.",
      };
    },
    async dispose() {},
  };
}

function buildLifecycleQualification(samples, parsed) {
  const thresholds = LIFECYCLE_THRESHOLDS;
  const requiredProfiles = ["narrow-10m", "wide-1m"];
  const requiredOwnership = "transfer";
  const requiredRowIdMode = "implicit";
  const measurements = requiredProfiles.map((profileId) => {
    const matching = samples.filter(
      (sample) =>
        sample.page.configuration.profile === profileId &&
        sample.page.configuration.ownership === requiredOwnership &&
        sample.page.configuration.rowIdMode === requiredRowIdMode,
    );
    const latency = matching.filter((sample) => sample.page.configuration.pass === "latency");
    const memory = matching.filter((sample) => sample.page.configuration.pass === "memory");
    const representative = memory[0] ?? latency[0] ?? null;
    const inputBytes = representative?.page.exactLedger.inputTypedArrayBytes ?? null;
    const ledger = representative?.page.exactLedger ?? null;
    const steadyRatio = ratio(ledger?.sortedSteadyKnownBytesLowerBound, inputBytes);
    const initialPeakRatio = ratio(ledger?.initialKnownPeakBytesLowerBound, inputBytes);
    const replacementPeakRatio = ratio(ledger?.replacementKnownPeakBytesLowerBound, inputBytes);
    const baselineUa = memory
      .map((sample) => memoryAt(sample.page.memorySamples, "after-grid-initialize-before-source"))
      .filter(isNumber);
    const releasedUa = memory
      .map((sample) => memoryAt(sample.page.memorySamples, "after-destroy-release-3"))
      .filter(isNumber);
    const residuals = baselineUa
      .map((baseline, index) =>
        releasedUa[index] === undefined ? null : Math.max(0, releasedUa[index] - baseline),
      )
      .filter(isNumber);
    const residualMedian = median(residuals);
    const residualMaximum =
      inputBytes === null
        ? null
        : Math.max(
            thresholds.postReleaseResidualBytesMaximum.fixedBytes,
            inputBytes * thresholds.postReleaseResidualBytesMaximum.inputFraction,
          );
    const initialSetDataSettledMedianMs = median(
      latency.map((sample) => sample.page.timings.initialSetDataSettledMs),
    );
    const replacementSetDataSettledMedianMs = median(
      latency.map((sample) => sample.page.timings.replacementSetDataSettledMs),
    );
    const rawSurfaceMedianMs = median(
      latency.map((sample) => sample.page.timings.initialSetDataToViewportCallbackMs),
    );
    const sortedSurfaceMedianMs = median(
      latency.map((sample) => sample.page.timings.immediateSortSetViewSettledMs),
    );
    const nonBuilderOverheadMedianMs = median(
      latency.map((sample) => sample.page.timings.firstSortNonBuilderOverheadMs).filter(isNumber),
    );
    const maxHeartbeatDelayMs = maximum(
      latency.flatMap((sample) =>
        sample.page.responsiveness
          .map((phase) => phase.maximumWorkerHeartbeatDelayMs)
          .filter(isNumber),
      ),
    );
    const workerTargetCounts = matching
      .map((sample) => sample.runner.workerTargetsAfterDestroy)
      .filter(isNumber);
    const workerDisappearanceValues = matching
      .map(
        (sample) => sample.runner.workerTargetLifecycle.lastGridWorkerDisappearanceAfterDestroyMs,
      )
      .filter(isNumber);
    const workerDisappearanceMaximumMs = maximum(workerDisappearanceValues);
    const workerTargetMeasurementAvailable =
      matching.length > 0 &&
      matching.every((sample) => sample.runner.workerTargetLifecycle.status === "available");
    const workerTargetsGone = workerTargetMeasurementAvailable
      ? workerTargetCounts.length === matching.length &&
        workerTargetCounts.every((value) => value === 0)
      : null;
    const correctnessPassed =
      matching.length > 0 &&
      matching.every(
        (sample) =>
          sample.page.correctness.passed &&
          sample.runner.browserErrors.length === 0 &&
          (sample.runner.workerTargetLifecycle.status !== "available" ||
            sample.runner.workerTargetsAfterDestroy === 0),
      );
    const fullScale = representative?.page.profile.rowScale === 1;
    const fields = {
      steadyAttributableBytesPerInputByte: measured(
        steadyRatio,
        thresholds.steadyAttributableBytesPerInputByteMaximum,
      ),
      firstTypedSortPeakBytesPerInputByte: measured(
        initialPeakRatio,
        thresholds.firstTypedSortPeakBytesPerInputByteMaximum,
      ),
      sameSizeReplacementPeakBytesPerInputByte: measured(
        replacementPeakRatio,
        thresholds.sameSizeReplacementPeakBytesPerInputByteMaximum,
      ),
      postReleaseUaSpecificResidualBytes: measured(residualMedian, residualMaximum),
      initialSetDataSettledMedianMs: measured(
        initialSetDataSettledMedianMs,
        thresholds.initialSetDataSettledMsMaximum,
      ),
      replacementSetDataSettledMedianMs: measured(
        replacementSetDataSettledMedianMs,
        thresholds.replacementSetDataSettledMsMaximum,
      ),
      maximumWorkerHeartbeatDelayMs: measured(
        maxHeartbeatDelayMs,
        thresholds.maximumWorkerHeartbeatDelayMsMaximum,
      ),
      initialViewportCallbackMedianMs: measured(
        rawSurfaceMedianMs,
        thresholds.initialViewportCallbackMsMaximum,
      ),
      immediateSortedSurfaceMedianMs: measured(
        sortedSurfaceMedianMs,
        thresholds.immediateSortedSurfaceMsMaximum[profileId],
      ),
      firstSortNonBuilderOverheadMedianMs: measured(
        nonBuilderOverheadMedianMs,
        thresholds.firstSortNonBuilderOverheadMsMaximum,
      ),
      workerTargetDisappearanceMaximumMs:
        workerTargetsGone === true
          ? measured(
              workerDisappearanceMaximumMs,
              thresholds.destroyWorkerTargetDisappearanceMsMaximum,
            )
          : workerTargetMeasurementAvailable
            ? {
                value: null,
                maximum: thresholds.destroyWorkerTargetDisappearanceMsMaximum,
                pass: false,
                reason: "one-or-more-grid-worker-targets-remained-active-after-release-settling",
              }
            : {
                value: null,
                maximum: thresholds.destroyWorkerTargetDisappearanceMsMaximum,
                pass: null,
                reason: "chromium-target-discovery-unavailable",
              },
    };
    const requiredFields = Object.entries(fields).filter(
      ([name]) => name !== "postReleaseUaSpecificResidualBytes",
    );
    return {
      profileId,
      ownership: requiredOwnership,
      rowIdMode: requiredRowIdMode,
      fullScale,
      latencySampleCount: latency.length,
      memorySampleCount: memory.length,
      exactLedgerSource:
        "source-derived unique typed-array byte ledger; lower bounds exclude browser/runtime objects and allocator effects",
      fields,
      workerTargetsAfterDestroy: workerTargetCounts,
      workerTargetsGone,
      workerTargetDisappearanceMeasurement: workerTargetMeasurementAvailable
        ? "Chromium Target discovery destroy-event receipt minus page-reported Grid.destroy start, aligned through epoch milliseconds"
        : "unavailable outside Chromium; in-page worker construction and termination accounting remains part of correctness",
      correctnessPassed,
      evaluable:
        fullScale === true &&
        latency.length > 0 &&
        memory.length > 0 &&
        requiredFields.every(([, value]) => value.pass !== null) &&
        workerTargetMeasurementAvailable &&
        workerTargetCounts.length === matching.length &&
        (workerTargetsGone === true || workerTargetCounts.some((value) => value > 0)),
      requiredPasses:
        correctnessPassed &&
        workerTargetsGone === true &&
        requiredFields.every(([, value]) => value.pass === true),
      optionalUaResidualPass: fields.postReleaseUaSpecificResidualBytes.pass,
    };
  });
  const evaluable =
    parsed.browser === "chromium" &&
    parsed.rowScale === 1 &&
    parsed.passes.includes("latency") &&
    parsed.passes.includes("memory") &&
    parsed.ownerships.includes(requiredOwnership) &&
    parsed.rowIdModes.includes(requiredRowIdMode) &&
    measurements.every((measurement) => measurement.evaluable);
  const passes = evaluable && measurements.every((measurement) => measurement.requiredPasses);
  const replacementLowerBoundMiss = measurements.some(
    (measurement) => measurement.fields.sameSizeReplacementPeakBytesPerInputByte.pass === false,
  );
  let decision;
  if (!evaluable) decision = "insufficient-evidence";
  else if (passes) decision = "worker-lifecycle-regression-qualification-passed";
  else if (replacementLowerBoundMiss) decision = "investigate-canonical-worker-replacement-overlap";
  else decision = "investigate-failed-lifecycle-dimensions";
  return {
    maturity: "regression-qualification",
    enforcement: "benchmark-regression-evidence",
    declaration:
      "Predeclared before production-lifecycle measurements. These are regression thresholds, not compatibility promises or public API commitments.",
    rationale:
      "The qualification checks that the production worker lifecycle avoids pathological copies, stalls, stale publication, and retained workers.",
    thresholds,
    statistic:
      "median of independent cold-browser latency samples; exact source-derived ratios for typed-array storage; UA memory residual median when available",
    requiredProfiles,
    requiredOwnership,
    requiredRowIdMode,
    requiredBrowser: "chromium",
    fullScaleRequired: true,
    passesRequired: ["latency", "memory"],
    evaluable,
    passes: evaluable ? passes : null,
    decision,
    measurements,
  };
}

function buildPortableLatencyQualification(samples, parsed) {
  const {
    postReleaseResidualBytesMaximum: _postReleaseResidualBytesMaximum,
    destroyWorkerTargetDisappearanceMsMaximum,
    ...sharedThresholds
  } = LIFECYCLE_THRESHOLDS;
  const thresholds = {
    ...sharedThresholds,
    destroyWorkerDisappearanceMsMaximum: destroyWorkerTargetDisappearanceMsMaximum,
  };
  const requiredProfiles = ["narrow-10m", "wide-1m"];
  const requiredOwnership = "transfer";
  const requiredRowIdMode = "implicit";
  const measurements = requiredProfiles.map((profileId) => {
    const latency = samples.filter(
      (sample) =>
        sample.page.configuration.profile === profileId &&
        sample.page.configuration.ownership === requiredOwnership &&
        sample.page.configuration.rowIdMode === requiredRowIdMode &&
        sample.page.configuration.pass === "latency",
    );
    const representative = latency[0] ?? null;
    const inputBytes = representative?.page.exactLedger.inputTypedArrayBytes ?? null;
    const ledger = representative?.page.exactLedger ?? null;
    const initialSetDataSettledMedianMs = median(
      latency.map((sample) => sample.page.timings.initialSetDataSettledMs),
    );
    const replacementSetDataSettledMedianMs = median(
      latency.map((sample) => sample.page.timings.replacementSetDataSettledMs),
    );
    const rawSurfaceMedianMs = median(
      latency.map((sample) => sample.page.timings.initialSetDataToViewportCallbackMs),
    );
    const sortedSurfaceMedianMs = median(
      latency.map((sample) => sample.page.timings.immediateSortSetViewSettledMs),
    );
    const nonBuilderOverheadMedianMs = median(
      latency.map((sample) => sample.page.timings.firstSortNonBuilderOverheadMs).filter(isNumber),
    );
    const maxHeartbeatDelayMs = maximum(
      latency.flatMap((sample) =>
        sample.page.responsiveness
          .map((phase) => phase.maximumWorkerHeartbeatDelayMs)
          .filter(isNumber),
      ),
    );
    const workerCounts = latency
      .map((sample) => sample.runner.workersAfterDestroy)
      .filter(isNumber);
    const workerDisappearanceValues = latency
      .map(
        (sample) => sample.runner.portableWorkerLifecycle.lastGridWorkerDisappearanceAfterDestroyMs,
      )
      .filter(isNumber);
    const workerDisappearanceMaximumMs = maximum(workerDisappearanceValues);
    const workerMeasurementAvailable =
      latency.length > 0 &&
      latency.every(
        (sample) =>
          sample.runner.portableWorkerLifecycle.status === "available" &&
          isNumber(sample.runner.portableWorkerLifecycle.gridWorkerCount) &&
          isNumber(sample.runner.workersAfterDestroy),
      );
    const gridWorkersObserved =
      workerMeasurementAvailable &&
      latency.every((sample) => sample.runner.portableWorkerLifecycle.gridWorkerCount > 0);
    const workersGone = workerMeasurementAvailable
      ? gridWorkersObserved &&
        latency.every(
          (sample) =>
            sample.runner.workersAfterDestroy === 0 &&
            sample.runner.portableWorkerLifecycle.allGridWorkersDestroyed === true,
        )
      : null;
    const fields = {
      steadyAttributableBytesPerInputByte: measured(
        ratio(ledger?.sortedSteadyKnownBytesLowerBound, inputBytes),
        thresholds.steadyAttributableBytesPerInputByteMaximum,
      ),
      firstTypedSortPeakBytesPerInputByte: measured(
        ratio(ledger?.initialKnownPeakBytesLowerBound, inputBytes),
        thresholds.firstTypedSortPeakBytesPerInputByteMaximum,
      ),
      sameSizeReplacementPeakBytesPerInputByte: measured(
        ratio(ledger?.replacementKnownPeakBytesLowerBound, inputBytes),
        thresholds.sameSizeReplacementPeakBytesPerInputByteMaximum,
      ),
      initialSetDataSettledMedianMs: measured(
        initialSetDataSettledMedianMs,
        thresholds.initialSetDataSettledMsMaximum,
      ),
      replacementSetDataSettledMedianMs: measured(
        replacementSetDataSettledMedianMs,
        thresholds.replacementSetDataSettledMsMaximum,
      ),
      maximumWorkerHeartbeatDelayMs: measured(
        maxHeartbeatDelayMs,
        thresholds.maximumWorkerHeartbeatDelayMsMaximum,
      ),
      initialViewportCallbackMedianMs: measured(
        rawSurfaceMedianMs,
        thresholds.initialViewportCallbackMsMaximum,
      ),
      immediateSortedSurfaceMedianMs: measured(
        sortedSurfaceMedianMs,
        thresholds.immediateSortedSurfaceMsMaximum[profileId],
      ),
      firstSortNonBuilderOverheadMedianMs: measured(
        nonBuilderOverheadMedianMs,
        thresholds.firstSortNonBuilderOverheadMsMaximum,
      ),
      workerDisappearanceMaximumMs:
        workersGone === true
          ? measured(workerDisappearanceMaximumMs, thresholds.destroyWorkerDisappearanceMsMaximum)
          : workerMeasurementAvailable
            ? {
                value: workerDisappearanceMaximumMs,
                maximum: thresholds.destroyWorkerDisappearanceMsMaximum,
                pass: false,
                reason: gridWorkersObserved
                  ? "one-or-more-grid-workers-remained-active-after-release-settling"
                  : "portable-worker-tracker-observed-no-grid-workers",
              }
            : {
                value: null,
                maximum: thresholds.destroyWorkerDisappearanceMsMaximum,
                pass: null,
                reason: "portable-playwright-worker-lifecycle-unavailable",
              },
    };
    const requiredFields = Object.values(fields);
    const correctnessPassed =
      latency.length > 0 &&
      latency.every(
        (sample) =>
          sample.page.correctness.passed &&
          sample.runner.browserErrors.length === 0 &&
          sample.runner.portableWorkerLifecycle.status === "available" &&
          sample.runner.portableWorkerLifecycle.gridWorkerCount > 0 &&
          sample.runner.portableWorkerLifecycle.allGridWorkersDestroyed === true,
      );
    const fullScale = representative?.page.profile.rowScale === 1;
    return {
      profileId,
      ownership: requiredOwnership,
      rowIdMode: requiredRowIdMode,
      fullScale,
      latencySampleCount: latency.length,
      exactLedgerSource:
        "source-derived unique typed-array byte ledger; lower bounds exclude browser/runtime objects and allocator effects",
      fields,
      workersAfterDestroy: workerCounts,
      workersGone,
      workerDisappearanceMeasurement:
        "Playwright Worker close-event receipt minus page-reported Grid.destroy start, aligned through epoch milliseconds",
      correctnessPassed,
      evaluable:
        fullScale === true &&
        latency.length > 0 &&
        workerMeasurementAvailable &&
        requiredFields.every((value) => value.pass !== null),
      requiredPasses: correctnessPassed && requiredFields.every((value) => value.pass === true),
    };
  });
  const evaluable =
    parsed.rowScale === 1 &&
    parsed.passes.includes("latency") &&
    parsed.ownerships.includes(requiredOwnership) &&
    parsed.rowIdModes.includes(requiredRowIdMode) &&
    measurements.every((measurement) => measurement.evaluable);
  const passes = evaluable && measurements.every((measurement) => measurement.requiredPasses);
  const replacementLowerBoundMiss = measurements.some(
    (measurement) => measurement.fields.sameSizeReplacementPeakBytesPerInputByte.pass === false,
  );
  let decision;
  if (!evaluable) decision = "insufficient-evidence";
  else if (passes)
    decision = "current-typescript-worker-lifecycle-meets-portable-latency-qualification";
  else if (replacementLowerBoundMiss) decision = "investigate-canonical-worker-replacement-overlap";
  else decision = "investigate-failed-portable-latency-dimensions";
  return {
    maturity: "regression-qualification",
    enforcement: "benchmark-regression-evidence",
    declaration:
      "Predeclared before cross-engine full-scale measurements. It reuses the existing lifecycle latency and exact typed-array ratio thresholds without adding engine-specific relaxations.",
    rationale:
      "This qualification asks whether the same TypeScript worker lifecycle remains responsive, correct, copy-bounded, and cleanly terminated in any Playwright browser engine. It deliberately excludes Chromium-only memory observations.",
    browserType: parsed.browser,
    browserDistribution: browserDistribution(parsed.browser),
    thresholds,
    thresholdOrigin: "shared lifecycle regression thresholds",
    statistic:
      "median of independent cold-browser latency samples; exact source-derived ratios for typed-array storage",
    requiredProfiles,
    requiredOwnership,
    requiredRowIdMode,
    fullScaleRequired: true,
    passesRequired: ["latency"],
    excludedMeasurements: [
      "performance.measureUserAgentSpecificMemory",
      "Chromium performance.memory",
      "Chromium CDP process-set RSS",
    ],
    evaluable,
    passes: evaluable ? passes : null,
    decision,
    measurements,
  };
}

function buildGenuineSafariLatencyObservation(samples, parsed) {
  if (parsed.browser !== "safari") return null;
  const portable = buildPortableLatencyQualification(samples, parsed);
  const measurements = portable.measurements.map((portableMeasurement) => {
    const latency = samples.filter(
      (sample) =>
        sample.page.configuration.profile === portableMeasurement.profileId &&
        sample.page.configuration.ownership === portableMeasurement.ownership &&
        sample.page.configuration.rowIdMode === portableMeasurement.rowIdMode &&
        sample.page.configuration.pass === "latency",
    );
    const { workerDisappearanceMaximumMs: _unobservableWorkerDisappearance, ...observedFields } =
      portableMeasurement.fields;
    const inPageWorkerLifecycle = {
      constructedCounts: latency.map((sample) => sample.page.workerTracking.constructed),
      terminateCallCounts: latency.map((sample) => sample.page.workerTracking.terminateCalls),
      activeAfterDestroyCounts: latency.map(
        (sample) => sample.page.workerTracking.activeAfterDestroy,
      ),
      allSamplesObservedGridConstructionAndTerminateCalls:
        latency.length > 0 &&
        latency.every(
          (sample) =>
            sample.page.workerTracking.constructed > 0 &&
            sample.page.workerTracking.terminateCalls >= sample.page.workerTracking.constructed &&
            sample.page.workerTracking.activeAfterDestroy === 0,
        ),
      evidence: "instrumented in-page Worker construction and terminate() call accounting only",
      caveat: "This does not prove when Safari's native worker execution contexts disappeared.",
    };
    const correctnessPassed =
      latency.length > 0 &&
      latency.every((sample) => sample.page.correctness.passed) &&
      inPageWorkerLifecycle.allSamplesObservedGridConstructionAndTerminateCalls;
    const fullScale = latency[0]?.page.profile.rowScale === 1;
    const observedThresholdsAvailable = Object.values(observedFields).every(
      (field) => field.pass !== null,
    );
    return {
      profileId: portableMeasurement.profileId,
      ownership: portableMeasurement.ownership,
      rowIdMode: portableMeasurement.rowIdMode,
      fullScale,
      latencySampleCount: latency.length,
      fields: observedFields,
      unobservedRequiredPortableField: {
        name: "workerDisappearanceMaximumMs",
        maximum: portable.thresholds.destroyWorkerDisappearanceMsMaximum,
        value: null,
        reason: "safaridriver-exposes-no-native-dedicated-worker-closure-events",
      },
      inPageWorkerLifecycle,
      correctnessPassed,
      completeObservedEvidence:
        fullScale === true && latency.length > 0 && observedThresholdsAvailable,
      withinObservedThresholds:
        correctnessPassed && Object.values(observedFields).every((field) => field.pass === true),
    };
  });
  const completeObservedEvidence =
    parsed.rowScale === 1 &&
    parsed.passes.length === 1 &&
    parsed.passes[0] === "latency" &&
    parsed.ownerships.includes("transfer") &&
    parsed.rowIdModes.includes("implicit") &&
    measurements.every((measurement) => measurement.completeObservedEvidence);
  const withinObservedThresholds =
    completeObservedEvidence &&
    measurements.every((measurement) => measurement.withinObservedThresholds);
  return {
    maturity: "installed-browser-observation-only-not-portable-qualification",
    enforcement: "descriptive-decision-support-only",
    browser: "Safari",
    browserDistribution: browserDistribution("safari"),
    declaration:
      "Genuine installed-Safari latency and correctness observation. It applies every lifecycle latency and exact-ledger threshold unchanged except native worker disappearance, which safaridriver cannot observe.",
    thresholds: portable.thresholds,
    thresholdOrigin: "shared lifecycle regression thresholds",
    nativeWorkerDisappearanceProof: "unavailable",
    portableLatencyQualificationClaimed: false,
    comparabilityCaveat:
      "Safari runs headed at the physical display's actual DPR with best-effort inner-window sizing. Compare descriptively with Playwright DPR-controlled artifacts unless those engines are rerun at the same actual DPR and viewport.",
    requiredProfiles: portable.requiredProfiles,
    requiredOwnership: portable.requiredOwnership,
    requiredRowIdMode: portable.requiredRowIdMode,
    fullScaleRequired: true,
    passesRequired: ["latency"],
    completeObservedEvidence,
    withinObservedThresholds: completeObservedEvidence ? withinObservedThresholds : null,
    decision: !completeObservedEvidence
      ? "insufficient-observed-evidence"
      : withinObservedThresholds
        ? "observed-dimensions-within-unchanged-thresholds-native-worker-closure-unproven"
        : "one-or-more-observed-dimensions-miss-unchanged-thresholds",
    measurements,
  };
}

function buildGenuineFirefoxLatencyObservation(samples, parsed) {
  if (parsed.browser !== "firefox-installed") return null;
  const portable = buildPortableLatencyQualification(samples, parsed);
  const measurements = portable.measurements.map((portableMeasurement) => {
    const latency = samples.filter(
      (sample) =>
        sample.page.configuration.profile === portableMeasurement.profileId &&
        sample.page.configuration.ownership === portableMeasurement.ownership &&
        sample.page.configuration.rowIdMode === portableMeasurement.rowIdMode &&
        sample.page.configuration.pass === "latency",
    );
    const { workerDisappearanceMaximumMs: _unobservableWorkerDisappearance, ...observedFields } =
      portableMeasurement.fields;
    const inPageWorkerLifecycle = {
      constructedCounts: latency.map((sample) => sample.page.workerTracking.constructed),
      terminateCallCounts: latency.map((sample) => sample.page.workerTracking.terminateCalls),
      activeAfterDestroyCounts: latency.map(
        (sample) => sample.page.workerTracking.activeAfterDestroy,
      ),
      allSamplesObservedGridConstructionAndTerminateCalls:
        latency.length > 0 &&
        latency.every(
          (sample) =>
            sample.page.workerTracking.constructed > 0 &&
            sample.page.workerTracking.terminateCalls >= sample.page.workerTracking.constructed &&
            sample.page.workerTracking.activeAfterDestroy === 0,
        ),
      evidence: "instrumented in-page Worker construction and terminate() call accounting only",
      caveat:
        "This does not prove when Firefox's native dedicated-worker execution contexts disappeared.",
    };
    const correctnessPassed =
      latency.length > 0 &&
      latency.every((sample) => sample.page.correctness.passed) &&
      inPageWorkerLifecycle.allSamplesObservedGridConstructionAndTerminateCalls;
    const fullScale = latency[0]?.page.profile.rowScale === 1;
    const observedThresholdsAvailable = Object.values(observedFields).every(
      (field) => field.pass !== null,
    );
    return {
      profileId: portableMeasurement.profileId,
      ownership: portableMeasurement.ownership,
      rowIdMode: portableMeasurement.rowIdMode,
      fullScale,
      latencySampleCount: latency.length,
      fields: observedFields,
      unobservedRequiredPortableField: {
        name: "workerDisappearanceMaximumMs",
        maximum: portable.thresholds.destroyWorkerDisappearanceMsMaximum,
        value: null,
        reason: "geckodriver-webdriver-classic-exposes-no-native-dedicated-worker-closure-events",
      },
      inPageWorkerLifecycle,
      correctnessPassed,
      completeObservedEvidence:
        fullScale === true && latency.length > 0 && observedThresholdsAvailable,
      withinObservedThresholds:
        correctnessPassed && Object.values(observedFields).every((field) => field.pass === true),
    };
  });
  const completeObservedEvidence =
    parsed.rowScale === 1 &&
    parsed.passes.length === 1 &&
    parsed.passes[0] === "latency" &&
    parsed.ownerships.includes("transfer") &&
    parsed.rowIdModes.includes("implicit") &&
    measurements.every((measurement) => measurement.completeObservedEvidence);
  const withinObservedThresholds =
    completeObservedEvidence &&
    measurements.every((measurement) => measurement.withinObservedThresholds);
  return {
    maturity: "installed-browser-observation-only-not-portable-qualification",
    enforcement: "descriptive-decision-support-only",
    browser: "Firefox",
    browserDistribution: browserDistribution("firefox-installed"),
    declaration:
      "Genuine installed-Firefox latency and correctness observation. It applies every lifecycle latency and exact-ledger threshold unchanged except native worker disappearance, which geckodriver WebDriver Classic cannot observe.",
    thresholds: portable.thresholds,
    thresholdOrigin: "shared lifecycle regression thresholds",
    nativeWorkerDisappearanceProof: "unavailable",
    portableLatencyQualificationClaimed: false,
    comparabilityCaveat:
      "Installed Firefox runs headed at the physical display's actual DPR with best-effort inner-window sizing. Compare descriptively with Playwright DPR-controlled artifacts unless those engines are rerun at the same actual DPR and viewport.",
    requiredProfiles: portable.requiredProfiles,
    requiredOwnership: portable.requiredOwnership,
    requiredRowIdMode: portable.requiredRowIdMode,
    fullScaleRequired: true,
    passesRequired: ["latency"],
    completeObservedEvidence,
    withinObservedThresholds: completeObservedEvidence ? withinObservedThresholds : null,
    decision: !completeObservedEvidence
      ? "insufficient-observed-evidence"
      : withinObservedThresholds
        ? "observed-dimensions-within-unchanged-thresholds-native-worker-closure-unproven"
        : "one-or-more-observed-dimensions-miss-unchanged-thresholds",
    measurements,
  };
}

function buildSummaries(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const configuration = sample.page.configuration;
    const key = `${configuration.ownership}/${configuration.rowIdMode}/${configuration.profile}/${configuration.pass}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [ownership, rowIdMode, profile, pass] = key.split("/");
    const timingKeys = [
      "gridInitializeMs",
      "initialSetDataCallReturnMs",
      "initialSetDataSettledMs",
      "initialSetDataToViewportCallbackMs",
      "initialHostIngressMs",
      "immediateSortSetViewSettledMs",
      "reportedWorkerBuildMs",
      "firstSortNonBuilderOverheadMs",
      "replacementSetDataCallReturnMs",
      "replacementSetDataSettledMs",
      "replacementSetDataToViewportCallbackMs",
      "replacementHostIngressMs",
      "destroySyncMs",
    ];
    return {
      ownership,
      rowIdMode,
      profile,
      pass,
      sampleCount: group.length,
      timings: Object.fromEntries(
        timingKeys.map((timing) => {
          const values = group.map((sample) => sample.page.timings[timing]).filter(isNumber);
          return [
            timing,
            {
              medianMs: median(values),
              p95Ms:
                values.length >= P95_MINIMUM_INDEPENDENT_SAMPLES ? percentile(values, 0.95) : null,
              p95MinimumSampleCount: P95_MINIMUM_INDEPENDENT_SAMPLES,
            },
          ];
        }),
      ),
      uaSpecificMemory: Object.fromEntries(
        memoryLabels(group).map((label) => [
          label,
          {
            medianBytes: median(
              group.map((sample) => memoryAt(sample.page.memorySamples, label)).filter(isNumber),
            ),
          },
        ]),
      ),
      processRss: {
        medianPeakBytes: median(
          group.map((sample) => sample.runner.processRss.peakRssBytes).filter(isNumber),
        ),
        medianPeakDeltaFromBaselineBytes: median(
          group
            .map((sample) => sample.runner.processRss.peakDeltaFromBaselineBytes)
            .filter(isNumber),
        ),
      },
      allCorrect: group.every((sample) => sample.page.correctness.passed),
    };
  });
}

function memoryLabels(group) {
  return [
    ...new Set(group.flatMap((sample) => sample.page.memorySamples.map((entry) => entry.label))),
  ];
}

function memoryAt(samples, label) {
  return samples.find((sample) => sample.label === label)?.userAgentSpecific.bytes ?? null;
}

function measured(value, maximum) {
  return {
    value: value ?? null,
    maximum: maximum ?? null,
    pass: value === null || value === undefined || maximum === null ? null : value <= maximum,
  };
}

function ratio(numerator, denominator) {
  return isNumber(numerator) && isNumber(denominator) && denominator > 0
    ? numerator / denominator
    : null;
}

function parseArguments(arguments_) {
  const parsed = {
    profiles: ["wide-1m", "narrow-10m"],
    ownerships: ["transfer"],
    rowIdModes: ["implicit"],
    passes: ["latency", "memory"],
    rowScale: 1,
    latencyRepetitions: 3,
    memoryRepetitions: 1,
    postDestroySettleMs: 750,
    rssIntervalMs: 100,
    browser: "chromium",
    dpr: 1,
    headed: false,
    timeoutMs: 10 * 60 * 1_000,
    sourceRoot: ".",
    geckoDriverPath: defaultGeckoDriverPath,
    firefoxApplicationPath: defaultFirefoxApplicationPath,
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
    else if (argument === "--ownerships") parsed.ownerships = list(arguments_[++index]);
    else if (argument === "--row-id-modes") parsed.rowIdModes = list(arguments_[++index]);
    else if (argument === "--passes") parsed.passes = list(arguments_[++index]);
    else if (argument === "--row-scale") {
      parsed.rowScale = boundedNumber(arguments_[++index], argument, 0, 1);
    } else if (argument === "--latency-repetitions") {
      parsed.latencyRepetitions = positiveInteger(arguments_[++index], argument);
    } else if (argument === "--memory-repetitions") {
      parsed.memoryRepetitions = positiveInteger(arguments_[++index], argument);
    } else if (argument === "--post-destroy-settle-ms") {
      parsed.postDestroySettleMs = nonNegativeNumber(arguments_[++index], argument);
    } else if (argument === "--rss-interval-ms") {
      parsed.rssIntervalMs = positiveInteger(arguments_[++index], argument);
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(arguments_[++index], argument);
    } else if (argument === "--dpr") {
      parsed.dpr = positiveNumber(arguments_[++index], argument);
    } else if (argument === "--browser") parsed.browser = arguments_[++index];
    else if (argument === "--geckodriver-path") parsed.geckoDriverPath = arguments_[++index];
    else if (argument === "--firefox-application-path") {
      parsed.firefoxApplicationPath = arguments_[++index];
    } else if (argument === "--source-root") parsed.sourceRoot = arguments_[++index];
    else if (argument === "--output") parsed.output = arguments_[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  validateList(parsed.profiles, ["narrow-10m", "wide-1m"], "profiles");
  validateList(parsed.ownerships, ["transfer", "copy"], "ownerships");
  validateList(parsed.rowIdModes, ["implicit", "explicit-number"], "row-id-modes");
  validateList(parsed.passes, ["latency", "memory"], "passes");
  if (!["chromium", "firefox", "firefox-installed", "webkit", "safari"].includes(parsed.browser)) {
    throw new Error("browser must be chromium, firefox, firefox-installed, webkit, or safari.");
  }
  if (isInstalledWebDriverBrowser(parsed.browser) && !parsed.headed) {
    throw new Error(
      `Genuine ${installedBrowserLabel(parsed.browser)} is headed-only; pass --headed.`,
    );
  }
  if (
    isInstalledWebDriverBrowser(parsed.browser) &&
    (parsed.passes.length !== 1 || parsed.passes[0] !== "latency")
  ) {
    throw new Error(
      `Genuine ${installedBrowserLabel(parsed.browser)} supports --passes latency only.`,
    );
  }
  if (!parsed.geckoDriverPath) throw new Error("--geckodriver-path must not be empty.");
  if (!parsed.firefoxApplicationPath) {
    throw new Error("--firefox-application-path must not be empty.");
  }
  return parsed;
}

function isInstalledWebDriverBrowser(browser) {
  return browser === "safari" || browser === "firefox-installed";
}

function installedBrowserLabel(browser) {
  if (browser === "safari") return "Safari";
  if (browser === "firefox-installed") return "Firefox";
  throw new Error(`${JSON.stringify(browser)} is not an installed WebDriver browser.`);
}

function defaultOutputPath(date) {
  const stamp = date
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `artifacts/benchmarks/grid/grid-production-lifecycle-${stamp}.json`;
}

function automationMetadata(browser, browserVersion) {
  if (browser === "safari") {
    const version = spawnSync(safariDriverPath, ["--version"], { encoding: "utf8" });
    const driverVersion = (version.stdout || version.stderr).trim() || null;
    return {
      name: "safaridriver",
      version: driverVersion,
      browserType: "safari",
      browserVersion,
      browserExecutablePath: safariApplicationPath,
      driverExecutablePath: safariDriverPath,
      headless: false,
      distribution: browserDistribution(browser),
      viewportControl:
        "best-effort WebDriver outer-window sizing adjusted toward a 1280x720 page viewport",
      devicePixelRatioControl: "native physical-display DPR; not emulated",
      externalDedicatedWorkerLifecycleEvents: "unavailable",
    };
  }
  if (browser === "firefox-installed") {
    const version = spawnSync(options.geckoDriverPath, ["--version"], { encoding: "utf8" });
    const driverVersion = (version.stdout || version.stderr).trim() || null;
    return {
      name: "geckodriver",
      version: driverVersion,
      browserType: "firefox-installed",
      browserVersion,
      browserExecutablePath: options.firefoxApplicationPath,
      driverExecutablePath: options.geckoDriverPath,
      headless: false,
      distribution: browserDistribution(browser),
      viewportControl:
        "best-effort WebDriver outer-window sizing adjusted toward a 1280x720 page viewport",
      devicePixelRatioControl: "native physical-display DPR; not emulated",
      externalDedicatedWorkerLifecycleEvents: "unavailable in WebDriver Classic",
      browserProcessIdentity:
        "per-sample moz:processID capability recorded in runner.webdriver.launchedBrowserProcessId",
    };
  }
  return {
    name: "playwright",
    version: playwrightVersion,
    browserType: browser,
    browserVersion,
    browserExecutablePath: browserTypes[browser].executablePath(),
    headless: !options.headed,
    distribution: browserDistribution(browser),
  };
}

function usage() {
  return `Sixtyfold production Grid lifecycle benchmark

Usage:
  pnpm benchmark:grid -- lifecycle [options]

Each Playwright profile/pass/repetition launches a fresh browser process. Genuine
Safari and installed Firefox launch a fresh driver process and WebDriver session per
sample. Latency passes do not sample memory; memory passes use UA-specific memory
checkpoints and advisory Chromium process-set RSS. Installed-browser observations use
in-page Worker instrumentation and cannot prove native worker closure.

Options:
  --profiles LIST                  wide-1m,narrow-10m (default: 1M then 10M)
  --ownerships LIST                transfer,copy (default: transfer)
  --row-id-modes LIST              implicit,explicit-number (default: implicit)
  --passes LIST                    latency,memory (default: both)
  --latency-repetitions N          independent cold sessions (default: 3)
  --memory-repetitions N           independent cold processes (default: 1)
  --row-scale N                    debug scale in (0,1]; only 1 is gate evidence
  --post-destroy-settle-ms N       release settling window (default: 750)
  --rss-interval-ms N              advisory process RSS cadence (default: 100)
  --source-root PATH               repository or packages/grid subject tree
  --output PATH                    raw JSON artifact path
  --browser NAME                   chromium, firefox, firefox-installed, webkit, or safari
  --geckodriver-path PATH          geckodriver executable (or SIXTYFOLD_GECKODRIVER_PATH)
  --firefox-application-path PATH  installed Firefox executable
  --dpr N                          emulated Playwright DPR; installed browsers use native DPR
  --headed                         show browser; required for installed WebDriver browsers
  --timeout-ms N                   per-sample timeout (default: 600000)
  --no-enforce                     write harness failures without exiting non-zero
  --quiet                          suppress artifact JSON on stdout
  --verbose                       show Vite output
  --help                          show this help

Playwright WebKit and Firefox are engine prequalifications, not branded-browser runs.
Installed Safari and Firefox are latency-only; compare them descriptively unless actual
DPR and viewport match. Regression qualification misses are recorded but do not fail
the command.
`;
}
