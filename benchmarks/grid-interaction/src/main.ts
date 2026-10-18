import { Grid } from "@grid-interaction/grid";
import { GRID_INTERNAL_SURFACE_TELEMETRY } from "@grid-interaction/telemetry";
import type { GridOptions, GridViewport } from "@grid-interaction/types";
import type {
  GridInteractionConfiguration,
  GridInteractionControl,
  GridInteractionDistribution,
  GridInteractionDriverGeometry,
  GridInteractionGeneratedDataset,
  GridInteractionGeneratorOutput,
  GridInteractionGeometrySample,
  GridInteractionLongTask,
  GridInteractionPageResult,
  GridInteractionPublishedEvent,
  GridInteractionTelemetryEvent,
} from "./contracts";

const status = document.querySelector<HTMLOutputElement>("#status");
const hostCandidate = document.querySelector<HTMLDivElement>("#grid-host");
if (!hostCandidate) throw new Error("Grid interaction benchmark host is missing.");
const host: HTMLDivElement = hostCandidate;
const configuration = parseConfiguration(new URL(location.href).searchParams);
const telemetryEvents: GridInteractionTelemetryEvent[] = [];
const longTasks: GridInteractionLongTask[] = [];
const geometrySamples: GridInteractionGeometrySample[] = [];
const pageRuntimeFailures: string[] = [];
let traceStartedAtMs: number | null = null;
let previousRafAtMs: number | null = null;
let geometryFrame = 0;

addEventListener("error", (event: ErrorEvent | Event) => {
  if (event instanceof ErrorEvent) {
    pageRuntimeFailures.push(
      event.error instanceof Error ? (event.error.stack ?? event.message) : event.message,
    );
  } else {
    pageRuntimeFailures.push("A benchmark page resource failed to load.");
  }
});
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  pageRuntimeFailures.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});

const longTaskObserver =
  typeof PerformanceObserver === "function" &&
  PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration });
        }
      })
    : null;
longTaskObserver?.observe({ type: "longtask", buffered: true });

void execute().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  setStage(`failed: ${normalized.message}`);
  globalThis.__SIXTYFOLD_GRID_INTERACTION_RESULT__ = {
    error: normalized.stack ?? normalized.message,
  };
});

async function execute(): Promise<void> {
  const failures: string[] = [];
  setStage("initializing-grid");
  const internalOptions = {
    [GRID_INTERNAL_SURFACE_TELEMETRY]: (event: unknown): void => {
      telemetryEvents.push({ ...(event as GridInteractionTelemetryEvent) });
    },
  };
  const options = {
    renderMode: "worker",
    rowHeight: 30,
    headerHeight: 38,
    rowNumberWidth: 64,
    columnWidth: configuration.profile === "wide-1m" ? 56 : 128,
    minColumnWidth: 48,
    maxColumnWidth: 320,
    overscanRows: 3,
    overscanColumns: 0,
    ...internalOptions,
  } as GridOptions;
  let grid: Grid | null = new Grid(host, options);
  await grid.initialize();

  setStage(`generating-${configuration.profile}`);
  const generated = await generateDataset();
  const profile = generated.profile;
  setStage("installing-data");
  await grid.setData(generated.data);

  if (configuration.profile === "narrow-10m") {
    setStage("sorting-narrow-profile");
    const view = await grid.setView({
      sort: [{ columnId: "value0", direction: "ascending", nulls: "last" }],
    });
    if (view.status !== "applied") failures.push("The prerequisite narrow sort was superseded.");
  }
  await nextAnimationFrame();
  await delay(40);

  const scrollport = requiredElement<HTMLElement>(host, "[data-grid-scrollport]");
  const initialCanvasRoot = requiredElement<HTMLElement>(host, "[data-grid-canvas]");
  const initialSemanticRoot = requiredElement<HTMLElement>(host, "[data-grid-semantics]");
  const diagnosticsBeforeTrace = { ...grid.getDiagnostics() };
  const beforeViewport = { ...grid.getViewport() };
  const firstColumnWidthBefore = firstColumnWidth();
  const traceTelemetryStart = telemetryEvents.length;
  const traceLongTaskStart = longTasks.length;
  let driverFinishedAtMs: number | null = null;
  let begun = false;
  let finishing = false;
  let finished = false;
  let wheelEventCount = 0;
  let untrustedWheelEventCount = 0;
  scrollport.addEventListener(
    "wheel",
    (event) => {
      if (traceStartedAtMs === null || finishing || finished) return;
      wheelEventCount++;
      if (!event.isTrusted) untrustedWheelEventCount++;
    },
    { capture: true, passive: true },
  );

  const begin = (): GridInteractionDriverGeometry => {
    if (begun) throw new Error("The interaction trace has already started.");
    begun = true;
    traceStartedAtMs = performance.now();
    previousRafAtMs = null;
    sampleGeometry();
    setStage(`running-${configuration.scenario}`);
    return driverGeometry();
  };

  const driverFinished = async (): Promise<void> => {
    if (!begun) throw new Error("The interaction trace was not started.");
    if (finishing || finished) return;
    finishing = true;
    driverFinishedAtMs = performance.now();
    setStage("settling-latest-intent");
    // Programmatic/native scrollbar changes enqueue `scroll` asynchronously.
    // Cross two frame boundaries before declaring which intent is latest.
    await nextAnimationFrame();
    await nextAnimationFrame();
    await waitForLatestIntentPublication(traceTelemetryStart, 10_000);
    await nextAnimationFrame();
    cancelAnimationFrame(geometryFrame);
    geometryFrame = 0;
    recordGeometry(performance.now(), false);
    finished = true;
    const telemetry = telemetryEvents.slice(traceTelemetryStart);
    const traceLongTasks = longTasks
      .slice(traceLongTaskStart)
      .filter((task) => task.startTimeMs >= (traceStartedAtMs ?? 0));
    const published = telemetry.filter(
      (event): event is GridInteractionPublishedEvent => event.type === "published",
    );
    const settledPublication = published.at(-1);
    const settledAtMs = settledPublication?.observedAtMs ?? performance.now();
    await delay(configuration.settleMs);
    const diagnosticsAfterTrace = { ...grid!.getDiagnostics() };
    const finalViewport = { ...grid!.getViewport() };
    const firstColumnWidthAfter = firstColumnWidth();
    const finalPhysicalTop = scrollport.scrollTop;
    const finalScrollLeft = scrollport.scrollLeft;
    const finalMaximumPhysicalTop = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
    const finalMaximumScrollLeft = Math.max(0, scrollport.scrollWidth - scrollport.clientWidth);
    const metrics = buildMetrics(
      telemetry,
      traceLongTasks,
      geometrySamples,
      wheelEventCount,
      untrustedWheelEventCount,
    );
    const latestIntent = telemetry
      .filter((event) => event.type === "intent")
      .reduce((latest, event) => Math.max(latest, event.intentId), 0);
    const lastPublished = published.at(-1) ?? null;
    const maximumPublishedLeft = maximum(published.map((event) => event.scrollLeft)) ?? 0;
    const maximumPublishedTop = maximum(published.map((event) => event.scrollTop)) ?? 0;
    const compressedLogicalCheckpoints =
      configuration.scenario !== "compressed-thumb" ||
      compressedCheckpointSequencePassed(telemetry, finalMaximumPhysicalTop);
    const expectedProfileForScenario =
      configuration.scenario === "vertical-wheel" || configuration.scenario === "compressed-thumb"
        ? configuration.profile === "narrow-10m"
        : configuration.profile === "wide-1m";
    const compressionExpected = profile.rows * 30 + 38 > 16_000_000;
    const logicalCompressionAsExpected =
      diagnosticsBeforeTrace.logicalScrollCompressed === compressionExpected;
    const endpointReached = scenarioEndpointReached({
      beforeViewport,
      finalViewport,
      physicalTop: finalPhysicalTop,
      left: finalScrollLeft,
      maximumTop: finalMaximumPhysicalTop,
      maximumLeft: finalMaximumScrollLeft,
      maximumPublishedTop,
      maximumPublishedLeft,
      firstColumnWidthBefore,
      firstColumnWidthAfter,
      telemetry,
      compressedLogicalCheckpoints,
    });
    const latestIntentPublished =
      latestIntent > 0 &&
      lastPublished !== null &&
      lastPublished.intentId === latestIntent &&
      lastPublished.latestIntentId === latestIntent;
    const publicationIntentOrderMonotonic = nonDecreasing(published.map((event) => event.intentId));
    const exactTerminalAccounting =
      metrics.unterminatedRequestedSurfaceCount === 0 &&
      metrics.multiplyTerminatedRequestedSurfaceCount === 0 &&
      metrics.duplicateSurfaceCorrelationCount === 0 &&
      metrics.orphanTerminalSurfaceCount === 0;
    const noRuntimeSurfaceDrops =
      metrics.runtimeCoalescedSurfaceDrops === 0 && metrics.runtimeStaleSurfaceDrops === 0;
    const boundedViewportPayload =
      metrics.maximumVisibleRows <= 24 &&
      metrics.maximumVisibleColumns <= 18 &&
      metrics.maximumCellCountProductMismatch === 0;
    const horizontalEndpointLanes =
      configuration.scenario !== "horizontal-wheel" ||
      (metrics.horizontalFarLaneObserved === true && metrics.horizontalReturnLaneObserved === true);
    const trustedWheelInput =
      (configuration.scenario !== "vertical-wheel" &&
        configuration.scenario !== "horizontal-wheel") ||
      (metrics.wheelEventCount > 0 && metrics.allObservedWheelEventsTrusted === true);
    const stableSurfaceRoots =
      host.querySelector("[data-grid-canvas]") === initialCanvasRoot &&
      host.querySelector("[data-grid-semantics]") === initialSemanticRoot;
    const workerPaintPath = diagnosticsAfterTrace.renderMode === "worker";
    const workerRuntimePath = diagnosticsAfterTrace.viewExecutionMode === "worker";
    const noPaintError = diagnosticsAfterTrace.paintError === null;

    if (!expectedProfileForScenario) failures.push("The scenario used the wrong workload profile.");
    if (!workerPaintPath) failures.push("The trace did not use the production paint worker.");
    if (!workerRuntimePath) failures.push("The trace did not use the canonical runtime worker.");
    if (!logicalCompressionAsExpected)
      failures.push("Logical scroll compression did not match the declared geometry.");
    if (!endpointReached) failures.push("The independent scenario endpoint was not reached.");
    if (!latestIntentPublished)
      failures.push("The latest observed interaction intent was not the final published surface.");
    if (!publicationIntentOrderMonotonic)
      failures.push("A stale surface published after a newer interaction intent surface.");
    if (!exactTerminalAccounting)
      failures.push("Requested surfaces did not each receive exactly one terminal outcome.");
    if (!noRuntimeSurfaceDrops)
      failures.push("The quiescent trace observed a runtime-stale or runtime-coalesced drop.");
    if (!boundedViewportPayload)
      failures.push("A runtime surface exceeded the bounded visible payload contract.");
    if (!horizontalEndpointLanes)
      failures.push("The horizontal trace did not publish exact 0–15 and 112–127 lanes.");
    if (!compressedLogicalCheckpoints)
      failures.push(
        "The compressed thumb trace did not publish the ordered physical and logical 25/50/75/100/50/0% checkpoints.",
      );
    if (!trustedWheelInput)
      failures.push("The wheel trace did not observe exclusively trusted browser wheel events.");
    if (!stableSurfaceRoots)
      failures.push("The Canvas or semantic Grid root was replaced during the trace.");
    if (!noPaintError) failures.push("The paint worker reported an error.");
    for (const runtimeFailure of new Set(pageRuntimeFailures)) {
      failures.push(`page runtime error: ${runtimeFailure}`);
    }

    grid!.destroy();
    grid = null;
    longTaskObserver?.disconnect();

    const result: GridInteractionPageResult = {
      configuration,
      profile,
      trace: {
        finalSettleMs: Math.max(0, settledAtMs - driverFinishedAtMs!),
      },
      metrics,
      correctness: {
        expectedProfileForScenario,
        workerPaintPath,
        workerRuntimePath,
        logicalCompressionAsExpected,
        endpointReached,
        latestIntentPublished,
        publicationIntentOrderMonotonic,
        exactTerminalAccounting,
        noRuntimeSurfaceDrops,
        boundedViewportPayload,
        horizontalEndpointLanes,
        compressedLogicalCheckpoints,
        trustedWheelInput,
        stableSurfaceRoots,
        noPaintError,
        passed: failures.length === 0,
      },
      failures,
    };
    globalThis.__SIXTYFOLD_GRID_INTERACTION_RESULT__ = result;
    setStage(failures.length === 0 ? "complete" : "complete-with-failures");
  };

  const control: GridInteractionControl = {
    begin,
    setCompressedThumbFraction: (fraction) => {
      const bounded = Math.max(0, Math.min(1, fraction));
      const maximum = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
      scrollport.scrollTop = maximum * bounded;
    },
    driverFinished,
  };
  globalThis.__SIXTYFOLD_GRID_INTERACTION_CONTROL__ = control;
  setStage("ready-for-driver");

  function firstColumnWidth(): number | null {
    const separator = host.querySelector<HTMLElement>(
      '[role="separator"][data-grid-column-id="number0"], [role="separator"][data-grid-column-id="value0"]',
    );
    const width = Number(separator?.getAttribute("aria-valuenow"));
    return Number.isFinite(width) ? width : null;
  }

  function driverGeometry(): GridInteractionDriverGeometry {
    const scrollRect = scrollport.getBoundingClientRect();
    const resizeHandle = host.querySelector<HTMLElement>(
      '[role="separator"][data-grid-column-id="number0"], [role="separator"][data-grid-column-id="value0"]',
    );
    const resizeRect = resizeHandle?.getBoundingClientRect();
    return {
      scrollport: rectSnapshot(scrollRect),
      resizeHandle: resizeRect ? rectSnapshot(resizeRect) : null,
      scrollTop: scrollport.scrollTop,
      scrollLeft: scrollport.scrollLeft,
      maximumTop: Math.max(0, scrollport.scrollHeight - scrollport.clientHeight),
      maximumLeft: Math.max(0, scrollport.scrollWidth - scrollport.clientWidth),
    };
  }

  function sampleGeometry(now = performance.now()): void {
    if (traceStartedAtMs === null || finished) return;
    recordGeometry(now, true);
    geometryFrame = requestAnimationFrame(sampleGeometry);
  }

  function recordGeometry(now: number, includeRafInterval: boolean): void {
    const scrollRect = scrollport.getBoundingClientRect();
    const canvasRect = requiredElement<HTMLElement>(
      host,
      "[data-grid-canvas]",
    ).getBoundingClientRect();
    const semanticRect = requiredElement<HTMLElement>(
      host,
      "[data-grid-semantics]",
    ).getBoundingClientRect();
    geometrySamples.push({
      observedAtMs: now,
      rafIntervalMs: !includeRafInterval || previousRafAtMs === null ? null : now - previousRafAtMs,
      scrollTop: scrollport.scrollTop,
      scrollLeft: scrollport.scrollLeft,
      canvasDriftX: Math.abs(canvasRect.left - scrollRect.left),
      canvasDriftY: Math.abs(canvasRect.top - scrollRect.top),
      semanticDriftX: Math.abs(semanticRect.left - scrollRect.left),
      semanticDriftY: Math.abs(semanticRect.top - scrollRect.top),
      canvasSemanticDriftX: Math.abs(canvasRect.left - semanticRect.left),
      canvasSemanticDriftY: Math.abs(canvasRect.top - semanticRect.top),
    });
    if (includeRafInterval) previousRafAtMs = now;
  }
}

function buildMetrics(
  telemetry: readonly GridInteractionTelemetryEvent[],
  traceLongTasks: readonly GridInteractionLongTask[],
  samples: readonly GridInteractionGeometrySample[],
  wheelEventCount: number,
  untrustedWheelEventCount: number,
): GridInteractionPageResult["metrics"] {
  const requested = telemetry.filter((event) => event.type === "requested");
  const runtimeReady = telemetry.filter((event) => event.type === "runtime-ready");
  const paintPresented = telemetry.filter((event) => event.type === "paint-presented");
  const published = telemetry.filter(
    (event): event is GridInteractionPublishedEvent => event.type === "published",
  );
  const dropped = telemetry.filter((event) => event.type === "dropped");
  const intents = telemetry.filter((event) => event.type === "intent");
  const presentationTimes = paintPresented.map((event) => event.observedAtMs);
  const requestedBySurface = new Map(requested.map((event) => [event.surfaceId, event]));
  const runtimeReadyBySurface = new Map(runtimeReady.map((event) => [event.surfaceId, event]));
  const paintPresentedBySurface = new Map(paintPresented.map((event) => [event.surfaceId, event]));
  const active = new Set<number>();
  let maximumConcurrentSurfaces = 0;
  for (const event of telemetry) {
    if (event.type === "requested") {
      active.add(event.surfaceId);
      maximumConcurrentSurfaces = Math.max(maximumConcurrentSurfaces, active.size);
    } else if (event.type === "published" || event.type === "dropped") {
      active.delete(event.surfaceId);
    }
  }
  const geometryDrifts = samples.flatMap((sample) => [
    sample.canvasDriftX,
    sample.canvasDriftY,
    sample.semanticDriftX,
    sample.semanticDriftY,
  ]);
  const canvasSemanticDriftDifferences = samples.flatMap((sample) => [
    sample.canvasSemanticDriftX,
    sample.canvasSemanticDriftY,
  ]);
  const finalGeometry = samples.at(-1);
  const requestedIntentIds = new Set(requested.map((event) => event.intentId));
  const intentCount = intents.length;
  const requestedCorrelations = requested.map(
    (event) => `${event.surfaceId}\0${event.commitToken}`,
  );
  const uniqueRequestedCorrelations = new Set(requestedCorrelations);
  const terminalCounts = new Map<string, number>();
  for (const event of [...published, ...dropped]) {
    const key = `${event.surfaceId}\0${event.commitToken}`;
    terminalCounts.set(key, (terminalCounts.get(key) ?? 0) + 1);
  }
  const runtimeRows = runtimeReady.map((event) => event.visibleRows);
  const runtimeColumns = runtimeReady.map((event) => event.visibleColumns);
  const horizontalFarLaneObserved =
    configuration.scenario === "horizontal-wheel"
      ? published.some(
          (event) => event.viewportColumnStart === 112 && event.viewportColumnEnd === 128,
        )
      : null;
  const lastPublishedSurface = published.at(-1);
  const horizontalReturnLaneObserved =
    configuration.scenario === "horizontal-wheel"
      ? lastPublishedSurface?.viewportColumnStart === 0 &&
        lastPublishedSurface.viewportColumnEnd === 16
      : null;
  return {
    intentToPublicationMs: distribution(
      published.map((event) => Math.max(0, event.observedAtMs - event.intentAtMs)),
    ),
    latestIntentLagMs: distribution(published.map((event) => event.latestIntentLagMs)),
    interPresentationMs: distribution(
      presentationTimes.slice(1).map((time, index) => time - presentationTimes[index]!),
    ),
    rafIntervalMs: distribution(samples.map((sample) => sample.rafIntervalMs).filter(isNumber)),
    runtimeFormatMs: distribution(runtimeReady.map((event) => event.formatDurationMs)),
    paintMs: distribution(paintPresented.map((event) => event.paintDurationMs)),
    semanticMs: distribution(paintPresented.map((event) => event.semanticDurationMs)),
    requestedToRuntimeReadyMs: distribution(
      runtimeReady.flatMap((event) => {
        const start = requestedBySurface.get(event.surfaceId)?.observedAtMs;
        return start === undefined ? [] : [event.observedAtMs - start];
      }),
    ),
    runtimeReadyToPaintReceiptMs: distribution(
      paintPresented.flatMap((event) => {
        const start = runtimeReadyBySurface.get(event.surfaceId)?.observedAtMs;
        return start === undefined ? [] : [event.observedAtMs - start];
      }),
    ),
    paintReceiptToSemanticCompleteMs: distribution(
      paintPresented.map((event) => event.semanticCompleteAtMs - event.observedAtMs),
    ),
    semanticCompleteToRuntimeAckMs: distribution(
      published.flatMap((event) => {
        const start = paintPresentedBySurface.get(event.surfaceId)?.semanticCompleteAtMs;
        return start === undefined ? [] : [event.runtimeAckAtMs - start];
      }),
    ),
    runtimeAckToPublicationMs: distribution(
      published.map((event) => event.observedAtMs - event.runtimeAckAtMs),
    ),
    achievedIntentHz:
      intents.length >= 2
        ? ((intents.length - 1) * 1000) / (intents.at(-1)!.observedAtMs - intents[0]!.observedAtMs)
        : null,
    longTaskObserverSupported: longTaskObserver !== null,
    wheelEventCount,
    untrustedWheelEventCount,
    allObservedWheelEventsTrusted: wheelEventCount > 0 ? untrustedWheelEventCount === 0 : null,
    intentCount,
    requestedSurfaceCount: requested.length,
    publishedSurfaceCount: published.length,
    droppedSurfaceCount: dropped.length,
    runtimeCoalescedSurfaceDrops: dropped.filter((event) => event.reason === "runtime-coalesced")
      .length,
    runtimeStaleSurfaceDrops: dropped.filter((event) => event.reason === "runtime-stale").length,
    coalescedIntentCount: Math.max(0, intentCount - requestedIntentIds.size),
    maximumSupersededIntentDepthAtPublication:
      maximum(published.map((event) => event.latestIntentId - event.intentId)) ?? 0,
    maximumConcurrentSurfaces,
    maximumVisibleGeometryDriftPx: maximum(geometryDrifts) ?? 0,
    maximumCanvasSemanticDriftDifferencePx: maximum(canvasSemanticDriftDifferences) ?? 0,
    finalSettledVisibleGeometryDriftPx: finalGeometry
      ? Math.max(
          finalGeometry.canvasDriftX,
          finalGeometry.canvasDriftY,
          finalGeometry.semanticDriftX,
          finalGeometry.semanticDriftY,
        )
      : 0,
    maximumVisibleRows: maximum(runtimeRows) ?? 0,
    maximumVisibleColumns: maximum(runtimeColumns) ?? 0,
    maximumCellCountProductMismatch:
      maximum(
        runtimeReady.map((event) =>
          Math.abs(event.cellCount - event.visibleRows * event.visibleColumns),
        ),
      ) ?? 0,
    unterminatedRequestedSurfaceCount: [...uniqueRequestedCorrelations].filter(
      (key) => (terminalCounts.get(key) ?? 0) === 0,
    ).length,
    multiplyTerminatedRequestedSurfaceCount: [...uniqueRequestedCorrelations].filter(
      (key) => (terminalCounts.get(key) ?? 0) > 1,
    ).length,
    duplicateSurfaceCorrelationCount:
      requestedCorrelations.length - uniqueRequestedCorrelations.size,
    orphanTerminalSurfaceCount: [...terminalCounts.keys()].filter(
      (key) => !uniqueRequestedCorrelations.has(key),
    ).length,
    horizontalFarLaneObserved,
    horizontalReturnLaneObserved,
    maximumLongTaskDurationMs: maximum(traceLongTasks.map((task) => task.durationMs)),
  };
}

function scenarioEndpointReached(input: {
  readonly beforeViewport: GridViewport;
  readonly finalViewport: GridViewport;
  readonly physicalTop: number;
  readonly left: number;
  readonly maximumTop: number;
  readonly maximumLeft: number;
  readonly maximumPublishedTop: number;
  readonly maximumPublishedLeft: number;
  readonly firstColumnWidthBefore: number | null;
  readonly firstColumnWidthAfter: number | null;
  readonly telemetry: readonly GridInteractionTelemetryEvent[];
  readonly compressedLogicalCheckpoints: boolean;
}): boolean {
  switch (configuration.scenario) {
    case "vertical-wheel":
      return (
        input.physicalTop > 0 &&
        input.finalViewport.rowStart > input.beforeViewport.rowStart &&
        input.maximumPublishedTop > 0
      );
    case "compressed-thumb":
      return (
        input.maximumTop > 0 &&
        input.compressedLogicalCheckpoints &&
        input.physicalTop <= 1 &&
        input.finalViewport.rowStart === 0
      );
    case "horizontal-wheel":
      return (
        input.maximumLeft > 0 &&
        input.maximumPublishedLeft >= input.maximumLeft * 0.75 &&
        input.left <= 1 &&
        input.finalViewport.columnStart === 0
      );
    case "resize-drag":
      return (
        input.firstColumnWidthBefore !== null &&
        input.firstColumnWidthAfter !== null &&
        Math.abs(input.firstColumnWidthAfter - (input.firstColumnWidthBefore + 48)) <= 1 &&
        input.telemetry.some((event) => event.type === "published" && event.source === "resize")
      );
  }
}

function compressedCheckpointSequencePassed(
  telemetry: readonly GridInteractionTelemetryEvent[],
  maximumPhysicalTop: number,
): boolean {
  if (!(maximumPhysicalTop > 0)) return false;
  const runtimeReadyBySurface = new Map(
    telemetry
      .filter((event) => event.type === "runtime-ready")
      .map((event) => [event.surfaceId, event] as const),
  );
  const published = telemetry.filter(
    (event): event is GridInteractionPublishedEvent =>
      event.type === "published" && event.source === "scroll",
  );
  const bottom = published.find(
    (event) =>
      Math.abs(event.intentScrollTop - maximumPhysicalTop) <= 1 &&
      event.viewportRowEnd === runtimeReadyBySurface.get(event.surfaceId)?.viewRowCount,
  );
  if (!bottom) return false;
  const maximumRowStart = bottom.viewportRowStart;
  const checkpoints = [0.25, 0.5, 0.75, 1, 0.5, 0] as const;
  let checkpointIndex = 0;
  for (const event of published) {
    const fraction = checkpoints[checkpointIndex];
    if (fraction === undefined) return true;
    const ready = runtimeReadyBySurface.get(event.surfaceId);
    const bottomMatches =
      fraction !== 1 || (ready !== undefined && event.viewportRowEnd === ready.viewRowCount);
    if (
      Math.abs(event.intentScrollTop - maximumPhysicalTop * fraction) <= 1 &&
      Math.abs(event.viewportRowStart - Math.round(maximumRowStart * fraction)) <= 1 &&
      bottomMatches
    ) {
      checkpointIndex++;
    }
  }
  return checkpointIndex === checkpoints.length;
}

async function waitForLatestIntentPublication(
  startIndex: number,
  timeoutMs: number,
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const trace = telemetryEvents.slice(startIndex);
    const latestIntentId = trace
      .filter((event) => event.type === "intent")
      .reduce((latest, event) => Math.max(latest, event.intentId), 0);
    const lastPublished = trace
      .filter((event): event is GridInteractionPublishedEvent => event.type === "published")
      .at(-1);
    if (
      latestIntentId > 0 &&
      lastPublished?.intentId === latestIntentId &&
      lastPublished.latestIntentId === latestIntentId
    ) {
      return;
    }
    await delay(4);
  }
  throw new Error("Timed out waiting for the latest interaction intent publication.");
}

async function generateDataset(): Promise<GridInteractionGeneratedDataset> {
  const worker = new Worker(new URL("./generator.worker.ts", import.meta.url), { type: "module" });
  try {
    return await withTimeout(
      new Promise<GridInteractionGeneratedDataset>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error("Generator worker clone failed."));
        worker.onmessage = (event: MessageEvent<GridInteractionGeneratorOutput>) => {
          if (event.data.type === "error")
            reject(new Error(event.data.stack ?? event.data.message));
          else {
            const { type: _type, ...generated } = event.data;
            resolve(generated);
          }
        };
        worker.postMessage({
          type: "generate",
          profile: configuration.profile,
          rowScale: configuration.rowScale,
        });
      }),
      120_000,
      `${configuration.profile} generator`,
    );
  } finally {
    worker.terminate();
  }
}

function parseConfiguration(parameters: URLSearchParams): GridInteractionConfiguration {
  const profile = parameters.get("profile") ?? "narrow-10m";
  if (profile !== "narrow-10m" && profile !== "wide-1m") {
    throw new Error(`Unknown interaction profile ${JSON.stringify(profile)}.`);
  }
  const scenario = parameters.get("scenario") ?? "vertical-wheel";
  if (
    scenario !== "vertical-wheel" &&
    scenario !== "compressed-thumb" &&
    scenario !== "horizontal-wheel" &&
    scenario !== "resize-drag"
  ) {
    throw new Error(`Unknown interaction scenario ${JSON.stringify(scenario)}.`);
  }
  return {
    profile,
    scenario,
    rowScale: boundedNumber(parameters.get("rowScale") ?? "1", "rowScale", 0, 1),
    sampleIndex: nonNegativeInteger(parameters.get("sampleIndex") ?? "0", "sampleIndex"),
    durationMs: positiveNumber(parameters.get("durationMs") ?? "5000", "durationMs"),
    cadenceHz: positiveNumber(parameters.get("cadenceHz") ?? "60", "cadenceHz"),
    settleMs: nonNegativeNumber(parameters.get("settleMs") ?? "100", "settleMs"),
  };
}

function distribution(values: readonly number[]): GridInteractionDistribution {
  const finite = values.filter(isNumber);
  if (finite.length === 0) return { count: 0, median: null, p95: null, maximum: null };
  const ordered = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
  return {
    count: ordered.length,
    median,
    p95: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]!,
    maximum: ordered.at(-1)!,
  };
}

function rectSnapshot(rect: DOMRect): GridInteractionDriverGeometry["scrollport"] {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Required benchmark element ${selector} is missing.`);
  return element;
}

function setStage(stage: string): void {
  globalThis.__SIXTYFOLD_GRID_INTERACTION_STAGE__ = stage;
  if (status) status.value = stage;
}

function nonDecreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]!);
}

function maximum(values: readonly number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}.`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function boundedNumber(
  value: string,
  label: string,
  exclusiveMinimum: number,
  inclusiveMaximum: number,
): number {
  const parsed = Number(value);
  if (!(parsed > exclusiveMinimum && parsed <= inclusiveMaximum)) {
    throw new Error(`${label} must be in (${exclusiveMinimum}, ${inclusiveMaximum}].`);
  }
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!(parsed > 0)) throw new Error(`${label} must be positive.`);
  return parsed;
}

function nonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}
