import { Grid } from "@grid-lifecycle/grid";
import type {
  GridData,
  GridDataInstallResult,
  GridDiagnostics,
  GridViewportChangeEvent,
} from "@grid-benchmark/types";
import type {
  GridLifecycleConfiguration,
  GridLifecycleDiagnostics,
  GridLifecycleExactLedger,
  GridLifecycleGeneratedDataset,
  GridLifecycleGeneratorOutput,
  GridLifecycleLongTask,
  GridLifecycleMemorySample,
  GridLifecyclePageResult,
  GridLifecycleResponsivenessPhase,
  GridLifecycleSurfaceRecord,
} from "./contracts";

const status = document.querySelector<HTMLOutputElement>("#status");
const hostCandidate = document.querySelector<HTMLDivElement>("#grid-host");
if (!hostCandidate) throw new Error("Grid lifecycle benchmark host is missing.");
const host: HTMLDivElement = hostCandidate;

const configuration = parseConfiguration(new URL(location.href).searchParams);
const workerTracker = installWorkerTracker();
const memorySamples: GridLifecycleMemorySample[] = [];
const longTasks: GridLifecycleLongTask[] = [];
const pageRuntimeFailures: string[] = [];
const responsivenessIntervals: Array<{
  phase: GridLifecycleResponsivenessPhase["phase"];
  startMs: number;
  endMs: number;
}> = [];
const heartbeatSamples: Array<{
  phase: GridLifecycleResponsivenessPhase["phase"];
  observedAtMs: number;
  delayMs: number;
}> = [];
let activeResponsivenessPhase: GridLifecycleResponsivenessPhase["phase"] | null = null;

addEventListener("error", (event: ErrorEvent | Event) => {
  if (event instanceof ErrorEvent) {
    pageRuntimeFailures.push(
      event.error instanceof Error ? (event.error.stack ?? event.message) : event.message,
    );
    return;
  }
  const target = event.target as
    (EventTarget & { readonly src?: string; readonly href?: string }) | null;
  pageRuntimeFailures.push(
    `resource load error: ${target?.src ?? target?.href ?? "unknown resource"}`,
  );
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

const heartbeat = new Worker(new URL("./heartbeat.worker.ts", import.meta.url), {
  type: "module",
});
heartbeat.addEventListener("message", (event: MessageEvent<{ readonly sentAtEpochMs: number }>) => {
  const phase = activeResponsivenessPhase;
  if (!phase) return;
  heartbeatSamples.push({
    phase,
    observedAtMs: performance.now(),
    delayMs: Math.max(0, epochNow() - event.data.sentAtEpochMs),
  });
});

void execute().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  setStage(`failed: ${normalized.message}`);
  globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__ = {
    error: normalized.stack ?? normalized.message,
  };
});

async function execute(): Promise<void> {
  const failures: string[] = [];
  const surfaces: GridLifecycleSurfaceRecord[] = [];
  const surfaceWaiters: Array<{
    readonly source: string;
    readonly datasetId: string;
    readonly afterMs: number;
    readonly resolve: (surface: GridLifecycleSurfaceRecord) => void;
  }> = [];
  let grid: Grid | null = null;
  let retainedSource: GridData | null = null;

  const onViewportChange = (event: GridViewportChangeEvent): void => {
    const record: GridLifecycleSurfaceRecord = {
      source: event.source,
      observedAtMs: performance.now(),
      ...event.viewport,
    };
    surfaces.push(record);
    for (let index = surfaceWaiters.length - 1; index >= 0; index--) {
      const waiter = surfaceWaiters[index]!;
      if (
        waiter.source === record.source &&
        waiter.datasetId === record.datasetId &&
        record.observedAtMs >= waiter.afterMs
      ) {
        surfaceWaiters.splice(index, 1);
        waiter.resolve(record);
      }
    }
  };

  const waitForSurface = (
    source: string,
    datasetId: string,
    afterMs: number,
  ): Promise<GridLifecycleSurfaceRecord> => {
    const existing = surfaces.find(
      (surface) =>
        surface.source === source &&
        surface.datasetId === datasetId &&
        surface.observedAtMs >= afterMs,
    );
    if (existing) return Promise.resolve(existing);
    return withTimeout(
      new Promise<GridLifecycleSurfaceRecord>((resolve) => {
        surfaceWaiters.push({ source, datasetId, afterMs, resolve });
      }),
      120_000,
      `renderer-confirmed ${source} surface for ${datasetId}`,
    );
  };

  setStage("initializing-grid");
  const initializeStartedAt = performance.now();
  grid = new Grid(host, {
    renderMode: "worker",
    onViewportChange,
  });
  await grid.initialize();
  const gridInitializeMs = performance.now() - initializeStartedAt;
  await sampleMemory("after-grid-initialize-before-source");
  await delay(40);

  setStage(`generating-initial-${configuration.profile}`);
  let initialGenerated: GridLifecycleGeneratedDataset | null = await generateDataset(0);
  const profile = initialGenerated.profile;
  const inputBytes = initialGenerated.sourceUniqueArrayBufferBytes;
  const inputBufferCount = initialGenerated.sourceBufferCount;
  const initialOracle = initialGenerated.oracle;
  retainedSource = initialGenerated.data;
  initialGenerated = null;
  await sampleMemory("initial-source-ready-before-set-data");

  setStage("initial-set-data-start");
  const initialSetDataPhaseStart = beginResponsiveness("initial-set-data");
  const initialSetDataStartedAt = performance.now();
  const initialInstallPromise = grid.setData(retainedSource);
  const initialSetDataCallReturnMs = performance.now() - initialSetDataStartedAt;
  const initialInputBytesImmediatelyAfterSetDataCall = uniqueArrayBufferBytes(retainedSource);
  const initialInstall = await initialInstallPromise;
  const initialSetDataSettledMs = performance.now() - initialSetDataStartedAt;
  const initialInputBytesAfterSetDataSettled = uniqueArrayBufferBytes(retainedSource);
  endResponsiveness("initial-set-data", initialSetDataPhaseStart);
  const initialSurface = await waitForSurface(
    "data",
    initialInstall.datasetId,
    initialSetDataStartedAt,
  );
  const initialSetDataToViewportCallbackMs = initialSurface.observedAtMs - initialSetDataStartedAt;
  const diagnosticsAfterInitialSurface = diagnostics(grid.getDiagnostics());
  const initialHostIngressMs = diagnosticsAfterInitialSurface.lastMainStoreInstallDurationMs;
  const semanticElement = host.querySelector<HTMLElement>("[data-grid-semantics]");
  const initialAriaRowCount = semanticElement?.getAttribute("aria-rowcount") ?? null;
  const initialAriaColumnCount = semanticElement?.getAttribute("aria-colcount") ?? null;
  await sampleMemory("after-initial-presented-surface");

  const sortColumn = initialOracle.sortColumnId;
  setStage("immediate-sort-start");
  const sortPhaseStart = beginResponsiveness("sort");
  const sortStartedAt = performance.now();
  const sorted = await grid.setView({
    sort: [{ columnId: sortColumn, direction: "ascending", nulls: "last" }],
  });
  const immediateSortSetViewSettledMs = performance.now() - sortStartedAt;
  await delay(30);
  endResponsiveness("sort", sortPhaseStart);
  if (sorted.status !== "applied") failures.push("The initial sort was superseded unexpectedly.");
  const diagnosticsAfterSortedSurface = diagnostics(grid.getDiagnostics());
  const reportedWorkerBuildMs = diagnosticsAfterSortedSurface.lastViewBuildDurationMs;
  const firstSortNonBuilderOverheadMs =
    reportedWorkerBuildMs === null
      ? null
      : Math.max(0, immediateSortSetViewSettledMs - reportedWorkerBuildMs);
  const finalViewStateBeforeReplacement = grid.getView();
  const sortedAriaSort =
    semanticElement
      ?.querySelector<HTMLElement>(`[role="columnheader"][data-grid-column-id="${sortColumn}"]`)
      ?.getAttribute("aria-sort") ?? null;
  const sortedVisibleGridCells = semanticElement?.querySelectorAll('[role="gridcell"]').length ?? 0;
  const actualFirstSortedValues = visibleNumericValues(semanticElement, sortColumn);
  const expectedFirstSortedValues = initialOracle.firstSortedValues.slice(
    0,
    actualFirstSortedValues.length,
  );
  await sampleMemory("after-initial-sort-presented");

  // Copy ownership deliberately retains the current caller image through the
  // steady checkpoint. Release it before constructing the replacement, which
  // models an application replacing rather than accumulating source state.
  retainedSource = null;
  setStage(`generating-replacement-${configuration.profile}`);
  let replacementGenerated: GridLifecycleGeneratedDataset | null = await generateDataset(1);
  const replacementOracle = replacementGenerated.oracle;
  retainedSource = replacementGenerated.data;
  replacementGenerated = null;
  await sampleMemory("replacement-source-ready-before-set-data");

  setStage("replacement-set-data-start");
  const replacementPhaseStart = beginResponsiveness("replacement-set-data");
  const replacementStartedAt = performance.now();
  const replacementInstallPromise = grid.setData(retainedSource);
  const replacementSetDataCallReturnMs = performance.now() - replacementStartedAt;
  const replacementInputBytesImmediatelyAfterSetDataCall = uniqueArrayBufferBytes(retainedSource);
  const datasetIdImmediatelyAfterReplacementSetDataCall = grid.getViewport().datasetId;
  const replacementInstall = await replacementInstallPromise;
  const replacementSetDataSettledMs = performance.now() - replacementStartedAt;
  const replacementInputBytesAfterSetDataSettled = uniqueArrayBufferBytes(retainedSource);
  endResponsiveness("replacement-set-data", replacementPhaseStart);
  const replacementSurface = await waitForSurface(
    "data",
    replacementInstall.datasetId,
    replacementStartedAt,
  );
  const replacementSetDataToViewportCallbackMs =
    replacementSurface.observedAtMs - replacementStartedAt;
  const actualReplacementPhysicalRowZeroValue = numericValueAtViewOrdinal(
    semanticElement,
    sortColumn,
    0,
  );
  const actualReplacementFocusedRowId = grid.getFocusedCell()?.rowId ?? null;
  const diagnosticsAfterReplacementPublication = diagnostics(grid.getDiagnostics());
  const replacementHostIngressMs =
    diagnosticsAfterReplacementPublication.lastMainStoreInstallDurationMs;
  await sampleMemory("after-replacement-publication");

  const exactLedger = buildExactLedger(
    profile.rows,
    inputBytes,
    inputBufferCount,
    initialInstall,
    diagnosticsAfterSortedSurface.lastPaintedCells,
  );

  const workerPaintPath = diagnosticsAfterSortedSurface.renderMode === "worker";
  const workerViewPath = diagnosticsAfterSortedSurface.viewExecutionMode === "worker";
  const canonicalWorkerOwnership =
    diagnosticsAfterSortedSurface.dataOwnershipMode === "runtime-worker";
  const boundedWorkerFormattedPaintPath =
    diagnosticsAfterSortedSurface.paintPipeline === "worker-formatted-bounded-viewport";
  const replacementCandidateStayedPrivate =
    datasetIdImmediatelyAfterReplacementSetDataCall === initialInstall.datasetId;
  const rawSurfaceConfirmed = initialSurface.datasetId === initialInstall.datasetId;
  const sortedSurfaceConfirmed =
    sorted.status === "applied" &&
    finalViewStateBeforeReplacement.status === "ready" &&
    finalViewStateBeforeReplacement.viewRevision === 1 &&
    sortedAriaSort === "ascending";
  const sortedVisibleValuesMatchOracle =
    actualFirstSortedValues.length > 0 &&
    actualFirstSortedValues.length === expectedFirstSortedValues.length &&
    actualFirstSortedValues.every((value, index) =>
      Object.is(value, expectedFirstSortedValues[index]),
    );
  const replacementSurfaceConfirmed =
    replacementSurface.datasetId === replacementInstall.datasetId &&
    replacementInstall.datasetId !== initialInstall.datasetId;
  const replacementMarkerValueMatchesOracle = Object.is(
    actualReplacementPhysicalRowZeroValue,
    replacementOracle.physicalRowZeroValue,
  );
  const replacementFocusedRowIdMatchesOracle = Object.is(
    actualReplacementFocusedRowId,
    replacementOracle.physicalRowZeroRowId,
  );
  const semanticCountsMatch =
    initialAriaRowCount === String(profile.rows + 1) &&
    initialAriaColumnCount === String(profile.logicalColumns + 1) &&
    sortedVisibleGridCells > 0;
  const transferInputsDetached =
    configuration.ownership === "transfer"
      ? initialInputBytesImmediatelyAfterSetDataCall === 0 &&
        initialInputBytesAfterSetDataSettled === 0 &&
        replacementInputBytesImmediatelyAfterSetDataCall === 0 &&
        replacementInputBytesAfterSetDataSettled === 0
      : null;
  const copyInputsRetained =
    configuration.ownership === "copy"
      ? initialInputBytesImmediatelyAfterSetDataCall === inputBytes &&
        initialInputBytesAfterSetDataSettled === inputBytes &&
        replacementInputBytesImmediatelyAfterSetDataCall === inputBytes &&
        replacementInputBytesAfterSetDataSettled === inputBytes
      : null;
  const noPaintError = diagnosticsAfterReplacementPublication.paintError === null;

  if (!workerPaintPath) failures.push("The production Grid did not use its paint worker.");
  if (!workerViewPath) failures.push("The production Grid did not use its runtime worker.");
  if (!canonicalWorkerOwnership)
    failures.push("The production Grid did not keep its canonical dataset in the runtime worker.");
  if (!boundedWorkerFormattedPaintPath)
    failures.push("The paint path was not fed a bounded worker-formatted viewport.");
  if (!replacementCandidateStayedPrivate)
    failures.push("The replacement dataset became public before its atomic publication.");
  if (!rawSurfaceConfirmed) failures.push("The initial renderer-confirmed surface is missing.");
  if (!sortedSurfaceConfirmed) failures.push("The sorted committed surface is incorrect.");
  if (!sortedVisibleValuesMatchOracle)
    failures.push("Visible sorted values do not match the independent generator oracle.");
  if (!replacementSurfaceConfirmed)
    failures.push("The replacement renderer-confirmed surface is missing or stale.");
  if (!replacementMarkerValueMatchesOracle)
    failures.push("The replacement marker value was not visible at physical row zero.");
  if (!replacementFocusedRowIdMatchesOracle)
    failures.push("The replacement focused RowId did not match physical row zero.");
  if (!semanticCountsMatch) failures.push("The semantic surface counts do not match the profile.");
  if (transferInputsDetached === false) failures.push("Transfer inputs were not detached.");
  if (copyInputsRetained === false) failures.push("Copy inputs did not remain caller-owned.");
  if (!noPaintError) failures.push("The paint worker reported an error.");

  setStage("destroying-grid");
  const destroyStartedAt = performance.now();
  const destroyStartedAtEpochMs = epochNow();
  grid.destroy();
  const destroySyncMs = performance.now() - destroyStartedAt;
  grid = null;
  retainedSource = null;
  heartbeat.postMessage({ type: "dispose" });
  heartbeat.terminate();
  host.replaceChildren();
  await delay(configuration.postDestroySettleMs);
  await sampleMemory("after-destroy-release-1");
  await sampleMemory("after-destroy-release-2");
  await sampleMemory("after-destroy-release-3");
  longTaskObserver?.disconnect();

  const tracked = workerTracker.snapshot();
  const gridWorkerUrls = tracked.urls.filter(
    (url) => !url.includes("generator.worker") && !url.includes("heartbeat.worker"),
  );
  const gridConstructed = gridWorkerUrls.length;
  const gridActiveAfterDestroy = tracked.activeUrls.filter(
    (url) => !url.includes("generator.worker") && !url.includes("heartbeat.worker"),
  ).length;
  if (gridActiveAfterDestroy !== 0) failures.push("Grid workers remain active after destroy.");
  for (const runtimeFailure of new Set(pageRuntimeFailures)) {
    failures.push(`page runtime error: ${runtimeFailure}`);
  }

  const responsiveness = responsivenessIntervals.map((interval) => {
    const heartbeats = heartbeatSamples
      .filter(
        (sample) =>
          sample.phase === interval.phase &&
          sample.observedAtMs >= interval.startMs &&
          sample.observedAtMs <= interval.endMs,
      )
      .map((sample) => sample.delayMs);
    const matchingLongTasks = longTasks.filter(
      (task) =>
        task.startTimeMs < interval.endMs && task.startTimeMs + task.durationMs > interval.startMs,
    );
    return {
      phase: interval.phase,
      samples: heartbeats.length,
      maximumWorkerHeartbeatDelayMs: maximum(heartbeats),
      p95WorkerHeartbeatDelayMs: percentile(heartbeats, 0.95),
      maximumLongTaskDurationMs: maximum(matchingLongTasks.map((task) => task.durationMs)),
    } satisfies GridLifecycleResponsivenessPhase;
  });

  const result: GridLifecyclePageResult = {
    configuration,
    profile,
    timings: {
      gridInitializeMs,
      initialSetDataCallReturnMs,
      initialSetDataSettledMs,
      initialSetDataToViewportCallbackMs,
      initialHostIngressMs,
      immediateSortSetViewSettledMs,
      reportedWorkerBuildMs,
      firstSortNonBuilderOverheadMs,
      replacementSetDataCallReturnMs,
      replacementSetDataSettledMs,
      replacementSetDataToViewportCallbackMs,
      replacementHostIngressMs,
      destroyStartedAtEpochMs,
      destroySyncMs,
    },
    exactLedger,
    memorySamples,
    responsiveness,
    workerTracking: {
      constructed: gridConstructed,
      terminateCalls: tracked.terminateCalls,
      activeAfterDestroy: gridActiveAfterDestroy,
      urls: gridWorkerUrls,
    },
    correctness: {
      workerPaintPath,
      workerViewPath,
      canonicalWorkerOwnership,
      boundedWorkerFormattedPaintPath,
      replacementCandidateStayedPrivate,
      rawSurfaceConfirmed,
      sortedSurfaceConfirmed,
      sortedVisibleValuesMatchOracle,
      replacementSurfaceConfirmed,
      replacementMarkerValueMatchesOracle,
      replacementFocusedRowIdMatchesOracle,
      semanticCountsMatch,
      transferInputsDetached,
      copyInputsRetained,
      noPaintError,
      passed: failures.length === 0,
    },
    failures,
    browser: browserMetadata(),
  };
  globalThis.__SIXTYFOLD_GRID_LIFECYCLE_RESULT__ = result;
  setStage(failures.length === 0 ? "complete" : "complete-with-failures");
}

function buildExactLedger(
  rows: number,
  inputBytes: number,
  inputBufferCount: number,
  install: GridDataInstallResult,
  paintedCells: number,
): GridLifecycleExactLedger {
  const activeSortPermutationBytes = rows * Uint32Array.BYTES_PER_ELEMENT;
  const workerSortScratchPermutationBytes = activeSortPermutationBytes;
  const workerRadixCountsBytes = 65_536 * Uint32Array.BYTES_PER_ELEMENT;
  const knownSortScratchBytesLowerBound =
    workerSortScratchPermutationBytes + workerRadixCountsBytes;
  const runtimeStoreInstalledReferencedBytes = install.buffers.reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  // Both public transfer buffers and exact-range private copy snapshots move
  // once into the canonical runtime. Public install provenance remains intact.
  const runtimeIngressTransferListBytes = inputBytes;
  const callerRetainedInputBytesAtSteadyCheckpoint =
    configuration.ownership === "copy" ? inputBytes : 0;
  const sortedSteadyKnownBytesLowerBound =
    inputBytes * (configuration.ownership === "copy" ? 2 : 1) + activeSortPermutationBytes;
  const initialKnownPeakBytesLowerBound =
    inputBytes * (configuration.ownership === "copy" ? 2 : 1) +
    activeSortPermutationBytes +
    knownSortScratchBytesLowerBound;
  const replacementKnownPeakBytesLowerBound =
    inputBytes * (configuration.ownership === "copy" ? 3 : 2) + activeSortPermutationBytes;
  return {
    inputTypedArrayBytes: inputBytes,
    inputArrayBufferCount: inputBufferCount,
    runtimeStoreInstalledReferencedBytes,
    runtimeIngressTransferListBytes,
    runtimeIngressTransferListCount: inputBufferCount,
    callerRetainedInputBytesAtSteadyCheckpoint,
    activeSortPermutationBytes,
    hostPublishedSortPermutationBytes: 0,
    hostInversePermutationBytes: 0,
    potentialWorkerInversePermutationBytes: activeSortPermutationBytes,
    potentialWorkerInverseIncludedInLowerBounds: false,
    workerSortScratchPermutationBytes,
    workerRadixCountsBytes,
    knownSortScratchBytesLowerBound,
    boundedPaintFrameTypedArrayBytes: paintedCells * 2,
    explicitRowIdTypedArrayBytes:
      configuration.rowIdMode === "explicit-number" ? rows * Float64Array.BYTES_PER_ELEMENT : 0,
    runtimeValidationUniquenessSetIncludedInLowerBounds: false,
    runtimeRowIdIndexMapIncludedInLowerBounds: false,
    initialKnownPeakBytesLowerBound,
    sortedSteadyKnownBytesLowerBound,
    replacementKnownPeakBytesLowerBound,
    ownershipAssumptions:
      configuration.ownership === "copy"
        ? [
            "The caller source is retained through the sorted steady checkpoint.",
            "The prior caller source is released before the replacement is generated.",
            "The Grid takes exact-range private copy snapshots and transfers them once into the canonical runtime worker.",
            "The active sort permutation and radix scratch remain private to the runtime worker.",
            "A physical-to-view inverse is lazy, worker-private, and is not exercised by this lifecycle.",
          ]
        : [
            "The caller ArrayBuffers enter private ingress ownership before async setData returns, then transfer once into the canonical runtime worker.",
            "The Grid host retains descriptors and a bounded visible RowId map, not a full dataset or permutation.",
            "The old runtime store and active permutation overlap the incoming replacement store until atomic paint publication.",
            "A physical-to-view inverse is lazy, worker-private, and is not exercised by this lifecycle.",
          ],
    caveat:
      "Exact for unique profile backing buffers and known typed-array outputs/scratch. It excludes the temporary runtime-validation JavaScript Set used for explicit RowId uniqueness, the runtime worker's persistent JavaScript RowId index Map, other JS objects and strings, bounded paint-frame transport copies, Canvas backing stores, allocator capacity, transient structured-clone implementation storage, and process overhead.",
  };
}

async function generateDataset(generation: number): Promise<GridLifecycleGeneratedDataset> {
  const worker = new Worker(new URL("./generator.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await withTimeout(
      new Promise<GridLifecycleGeneratedDataset>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error("Generator worker clone failed."));
        worker.onmessage = (event: MessageEvent<GridLifecycleGeneratorOutput>) => {
          if (event.data.type === "error") {
            reject(new Error(event.data.stack ?? event.data.message));
          } else {
            const { type: _type, ...generated } = event.data;
            resolve(generated);
          }
        };
        worker.postMessage({
          type: "generate",
          profile: configuration.profile,
          rowScale: configuration.rowScale,
          ownership: configuration.ownership,
          rowIdMode: configuration.rowIdMode,
          generation,
        });
      }),
      120_000,
      `${configuration.profile} generator`,
    );
  } finally {
    worker.terminate();
  }
}

async function sampleMemory(label: string): Promise<void> {
  if (configuration.pass !== "memory") {
    memorySamples.push({
      label,
      measuredAtMs: performance.now(),
      userAgentSpecific: {
        status: "not-sampled",
        bytes: null,
      },
    });
    return;
  }
  const extended = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{
      readonly bytes: number;
    }>;
  };
  let userAgentSpecific: GridLifecycleMemorySample["userAgentSpecific"];
  if (typeof extended.measureUserAgentSpecificMemory !== "function") {
    userAgentSpecific = {
      status: "unsupported",
      bytes: null,
    };
  } else {
    try {
      const result = await extended.measureUserAgentSpecificMemory();
      userAgentSpecific = {
        status: "available",
        bytes: result.bytes,
      };
    } catch (error) {
      userAgentSpecific = {
        status: "error",
        bytes: null,
      };
    }
  }
  memorySamples.push({
    label,
    measuredAtMs: performance.now(),
    userAgentSpecific,
  });
}

function beginResponsiveness(phase: GridLifecycleResponsivenessPhase["phase"]): number {
  activeResponsivenessPhase = phase;
  return performance.now();
}

function endResponsiveness(
  phase: GridLifecycleResponsivenessPhase["phase"],
  startMs: number,
): void {
  const endMs = performance.now();
  activeResponsivenessPhase = null;
  responsivenessIntervals.push({ phase, startMs, endMs });
}

function diagnostics(value: GridDiagnostics): GridLifecycleDiagnostics {
  return { ...value } as GridLifecycleDiagnostics;
}

function visibleNumericValues(semantics: HTMLElement | null, columnId: string): readonly number[] {
  if (!semantics) return [];
  return [
    ...semantics.querySelectorAll<HTMLElement>(
      `[role="gridcell"][data-grid-column-id="${columnId}"]`,
    ),
  ]
    .map((cell) => ({
      ordinal: Number(cell.dataset.gridViewOrdinal),
      value: Number(cell.textContent),
    }))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => entry.value);
}

function numericValueAtViewOrdinal(
  semantics: HTMLElement | null,
  columnId: string,
  viewOrdinal: number,
): number | null {
  const cell = semantics?.querySelector<HTMLElement>(
    `[role="gridcell"][data-grid-column-id="${columnId}"][data-grid-view-ordinal="${viewOrdinal}"]`,
  );
  return cell ? Number(cell.textContent) : null;
}

function uniqueArrayBufferBytes(value: unknown): number {
  const buffers = new Set<ArrayBuffer>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (ArrayBuffer.isView(candidate)) {
      if (candidate.buffer instanceof ArrayBuffer) buffers.add(candidate.buffer);
      return;
    }
    if (candidate instanceof ArrayBuffer) {
      buffers.add(candidate);
      return;
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}

function installWorkerTracker(): {
  snapshot: () => {
    readonly urls: readonly string[];
    readonly activeUrls: readonly string[];
    readonly terminateCalls: number;
  };
} {
  const NativeWorker = globalThis.Worker;
  const entries: Array<{ readonly url: string; active: boolean }> = [];
  let terminateCalls = 0;
  class TrackedWorker extends NativeWorker {
    private readonly trackedEntry: { readonly url: string; active: boolean };

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);
      this.trackedEntry = { url: String(scriptURL), active: true };
      entries.push(this.trackedEntry);
    }

    override terminate(): void {
      terminateCalls++;
      this.trackedEntry.active = false;
      super.terminate();
    }
  }
  globalThis.Worker = TrackedWorker as typeof Worker;
  return {
    snapshot: () => ({
      urls: entries.map((entry) => entry.url),
      activeUrls: entries.filter((entry) => entry.active).map((entry) => entry.url),
      terminateCalls,
    }),
  };
}

function browserMetadata(): GridLifecyclePageResult["browser"] {
  const navigatorWithMemory = navigator as Navigator & { readonly deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigatorWithMemory.deviceMemory ?? null,
    crossOriginIsolated,
    isSecureContext,
    devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
  };
}

function parseConfiguration(parameters: URLSearchParams): GridLifecycleConfiguration {
  const profile = parameters.get("profile") ?? "narrow-10m";
  if (profile !== "narrow-10m" && profile !== "wide-1m") {
    throw new Error(`Unknown lifecycle profile ${JSON.stringify(profile)}.`);
  }
  const ownership = parameters.get("ownership") ?? "transfer";
  if (ownership !== "transfer" && ownership !== "copy") {
    throw new Error("ownership must be transfer or copy.");
  }
  const pass = parameters.get("pass") ?? "latency";
  if (pass !== "latency" && pass !== "memory") {
    throw new Error("pass must be latency or memory.");
  }
  const rowIdMode = parameters.get("rowIdMode") ?? "implicit";
  if (rowIdMode !== "implicit" && rowIdMode !== "explicit-number") {
    throw new Error("rowIdMode must be implicit or explicit-number.");
  }
  return {
    profile,
    ownership,
    pass,
    rowIdMode,
    rowScale: boundedNumber(parameters.get("rowScale") ?? "1", "rowScale", 0, 1),
    sampleIndex: nonNegativeInteger(parameters.get("sampleIndex") ?? "0", "sampleIndex"),
    postDestroySettleMs: nonNegativeNumber(
      parameters.get("postDestroySettleMs") ?? "500",
      "postDestroySettleMs",
    ),
  };
}

function setStage(stage: string): void {
  globalThis.__SIXTYFOLD_GRID_LIFECYCLE_STAGE__ = stage;
  if (status) status.value = stage;
}

function maximum(values: readonly number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1)]!;
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function nonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}
