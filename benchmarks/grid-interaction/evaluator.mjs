export const INTERACTION_SCENARIOS = Object.freeze([
  "vertical-wheel",
  "compressed-thumb",
  "horizontal-wheel",
  "resize-drag",
]);

export const INTERACTION_THRESHOLDS = Object.freeze({
  medianIntentToPublicationMsMaximum: 25,
  p95IntentToPublicationMsMaximum: 50,
  p95InterPresentationMsMaximum: 33.3,
  p95RafIntervalMsMaximum: 33.3,
  finalSettleMsMaximum: 100,
  longTaskDurationMsExclusiveMaximum: 50,
  canvasSemanticDriftDifferencePxMaximum: 1,
  finalSettledVisibleGeometryDriftPxMaximum: 1,
  maximumConcurrentSurfaces: 1,
  runtimeCoalescedSurfaceDrops: 0,
  minimumAchievedSustainedIntentHz: 54,
  sustainedDriverDurationToleranceRatio: 0.1,
  correctnessRequired: true,
});

export function buildInteractionGate(samples, options, harnessFailures) {
  const fullScale = options.rowScale === 1;
  const allScenarios = INTERACTION_SCENARIOS.every((scenario) =>
    options.scenarios.includes(scenario),
  );
  const canonicalConfiguration =
    options.repetitions >= 3 &&
    options.durationMs >= 5_000 &&
    options.cadenceHz >= 60 &&
    options.browser === "chromium" &&
    options.dpr === 1;
  const measurements = samples.map((sample) => buildMeasurement(sample));
  const canonicalEvidencePresent =
    fullScale &&
    allScenarios &&
    canonicalConfiguration &&
    measurements.length >= INTERACTION_SCENARIOS.length * 3;
  const sustainedMeasurements = measurements.filter(
    (measurement) => measurement.scenario !== "compressed-thumb",
  );
  const achievedDriverLoad =
    sustainedMeasurements.length > 0 &&
    sustainedMeasurements.every(
      (measurement) => measurement.fields.achievedIntentHzMinimum.pass === true,
    );
  const achievedDriverDuration = sustainedMeasurements.every(
    (measurement) => measurement.fields.actualSustainedDriverDurationMs.pass === true,
  );
  const longTaskEvidenceAvailable = measurements.every(
    (measurement) => measurement.fields.longTaskObserverSupported.pass === true,
  );
  const evaluable =
    canonicalEvidencePresent &&
    achievedDriverLoad &&
    achievedDriverDuration &&
    longTaskEvidenceAvailable;
  const passes =
    evaluable &&
    harnessFailures.length === 0 &&
    measurements.every(
      (measurement) => measurement.correctnessPassed && measurement.withinThresholds,
    );
  const decision = !canonicalEvidencePresent
    ? "insufficient-evidence"
    : !achievedDriverLoad
      ? "insufficient-evidence-driver-load-not-achieved"
      : !achievedDriverDuration
        ? "insufficient-evidence-driver-duration-not-achieved"
        : !longTaskEvidenceAvailable
          ? "insufficient-evidence-long-task-observer-unavailable"
          : harnessFailures.length > 0
            ? "harness-or-worker-lifecycle-failure"
            : passes
              ? "typescript-worker-surface-pipeline-meets-experimental-interaction-gate"
              : "surface-pipeline-redesign-or-optimization-required-before-summary-ui";
  return {
    maturity: "experimental-non-release-non-api-freeze",
    enforcement: "decision-support-only",
    declaration: "Thresholds were fixed before the first full-scale interaction trace.",
    rationale:
      "Measures the serial main-rAF to runtime-format to paint-worker to semantic-DOM to runtime-ack publication path under sustained interaction. Absolute transient translated-surface lag is reported but not gated; Canvas and semantic surfaces must remain aligned with each other and settle onto the viewport. The fixed-step compressed-thumb scenario records but does not gate inter-presentation spacing because its authored checkpoint interval is not a frame-cadence workload.",
    thresholds: INTERACTION_THRESHOLDS,
    eventPercentileCaveat:
      "Within-trace p95 values describe correlated interaction events, not independent cold-process tail samples. Fresh-process medians are summarized separately.",
    retainedMemoryCaveat:
      "performance.memory is descriptive main-isolate evidence only and is not used as a whole-grid retained-memory gate.",
    driverLoadPolicy:
      "Achieved sustained intent cadence, actual driver duration within ±10% of the configured duration, and Long Task observer support are evaluability prerequisites. A trace that misses one of these evidence conditions cannot produce a product-redesign decision.",
    fullScaleRequired: true,
    canonicalConfigurationRequired: {
      browser: "chromium",
      minimumFreshProcessesPerScenario: 3,
      minimumDurationMs: 5_000,
      minimumRequestedCadenceHz: 60,
      minimumAchievedSustainedIntentHz: INTERACTION_THRESHOLDS.minimumAchievedSustainedIntentHz,
      sustainedDriverDurationToleranceRatio:
        INTERACTION_THRESHOLDS.sustainedDriverDurationToleranceRatio,
      longTaskObserverSupportRequired: true,
      devicePixelRatio: 1,
      viewport: { width: 1_280, height: 720 },
      host: { width: 960, height: 540 },
    },
    requiredScenarios: INTERACTION_SCENARIOS,
    canonicalEvidencePresent,
    achievedDriverLoad,
    achievedDriverDuration,
    longTaskEvidenceAvailable,
    evaluable,
    harnessFailureCount: harnessFailures.length,
    passes: evaluable ? passes : null,
    decision,
    measurements,
  };
}

function buildMeasurement(sample) {
  const metrics = sample.page.metrics;
  const scenario = sample.page.configuration.scenario;
  const publicationMinimum =
    scenario === "compressed-thumb"
      ? null
      : scenario === "resize-drag"
        ? Math.floor((48 * sample.page.configuration.durationMs) / 2_000)
        : Math.floor((120 * sample.page.configuration.durationMs) / 5_000);
  const fields = {
    medianIntentToPublicationMs: measured(
      metrics.intentToPublicationMs.median,
      INTERACTION_THRESHOLDS.medianIntentToPublicationMsMaximum,
    ),
    p95IntentToPublicationMs: measured(
      metrics.intentToPublicationMs.p95,
      INTERACTION_THRESHOLDS.p95IntentToPublicationMsMaximum,
    ),
    p95InterPresentationMs:
      scenario === "compressed-thumb"
        ? notApplicable(
            metrics.interPresentationMs.p95,
            "fixed-authored-checkpoint-spacing-is-not-frame-cadence",
          )
        : measured(
            metrics.interPresentationMs.p95,
            INTERACTION_THRESHOLDS.p95InterPresentationMsMaximum,
          ),
    p95RafIntervalMs: measured(
      metrics.rafIntervalMs.p95,
      INTERACTION_THRESHOLDS.p95RafIntervalMsMaximum,
    ),
    finalSettleMs: measured(
      sample.page.trace.finalSettleMs,
      INTERACTION_THRESHOLDS.finalSettleMsMaximum,
    ),
    maximumLongTaskDurationMs: measuredExclusive(
      metrics.maximumLongTaskDurationMs ?? 0,
      INTERACTION_THRESHOLDS.longTaskDurationMsExclusiveMaximum,
    ),
    maximumCanvasSemanticDriftDifferencePx: measured(
      metrics.maximumCanvasSemanticDriftDifferencePx,
      INTERACTION_THRESHOLDS.canvasSemanticDriftDifferencePxMaximum,
    ),
    finalSettledVisibleGeometryDriftPx: measured(
      metrics.finalSettledVisibleGeometryDriftPx,
      INTERACTION_THRESHOLDS.finalSettledVisibleGeometryDriftPxMaximum,
    ),
    maximumConcurrentSurfaces: measured(
      metrics.maximumConcurrentSurfaces,
      INTERACTION_THRESHOLDS.maximumConcurrentSurfaces,
    ),
    runtimeCoalescedSurfaceDrops: measured(
      metrics.runtimeCoalescedSurfaceDrops,
      INTERACTION_THRESHOLDS.runtimeCoalescedSurfaceDrops,
    ),
    runtimeStaleSurfaceDrops: measured(metrics.runtimeStaleSurfaceDrops, 0),
    unterminatedRequestedSurfaceCount: measured(metrics.unterminatedRequestedSurfaceCount, 0),
    multiplyTerminatedRequestedSurfaceCount: measured(
      metrics.multiplyTerminatedRequestedSurfaceCount,
      0,
    ),
    duplicateSurfaceCorrelationCount: measured(metrics.duplicateSurfaceCorrelationCount, 0),
    orphanTerminalSurfaceCount: measured(metrics.orphanTerminalSurfaceCount, 0),
    maximumVisibleRows: measured(metrics.maximumVisibleRows, 24),
    maximumVisibleColumns: measured(metrics.maximumVisibleColumns, 18),
    maximumCellCountProductMismatch: measured(metrics.maximumCellCountProductMismatch, 0),
    publishedSurfaceCountMinimum:
      publicationMinimum === null
        ? notApplicable(metrics.publishedSurfaceCount, "fixed-seven-step-compressed-thumb-trace")
        : measuredMinimum(metrics.publishedSurfaceCount, publicationMinimum),
    achievedIntentHzMinimum:
      scenario === "compressed-thumb"
        ? notApplicable(metrics.achievedIntentHz, "fixed-seven-step-compressed-thumb-trace")
        : measuredMinimum(
            metrics.achievedIntentHz,
            INTERACTION_THRESHOLDS.minimumAchievedSustainedIntentHz,
          ),
    actualSustainedDriverDurationMs:
      scenario === "compressed-thumb"
        ? notApplicable(
            sample.runner?.inputDriver?.actualCommandDurationMs,
            "fixed-seven-step-compressed-thumb-trace",
          )
        : measuredRange(
            sample.runner?.inputDriver?.actualCommandDurationMs,
            sample.page.configuration.durationMs *
              (1 - INTERACTION_THRESHOLDS.sustainedDriverDurationToleranceRatio),
            sample.page.configuration.durationMs *
              (1 + INTERACTION_THRESHOLDS.sustainedDriverDurationToleranceRatio),
          ),
    longTaskObserverSupported: requiredBoolean(metrics.longTaskObserverSupported),
    horizontalFarLaneObserved:
      scenario === "horizontal-wheel"
        ? requiredBoolean(metrics.horizontalFarLaneObserved)
        : notApplicable(null, "non-horizontal-scenario"),
    horizontalReturnLaneObserved:
      scenario === "horizontal-wheel"
        ? requiredBoolean(metrics.horizontalReturnLaneObserved)
        : notApplicable(null, "non-horizontal-scenario"),
  };
  return {
    scenario,
    sampleIndex: sample.page.configuration.sampleIndex,
    fields,
    correctnessPassed: sample.page.correctness.passed,
    withinThresholds: Object.values(fields).every((field) => field.pass === true),
  };
}

function measured(value, maximum) {
  return { value: value ?? null, maximum, pass: isNumber(value) ? value <= maximum : null };
}

function measuredExclusive(value, exclusiveMaximum) {
  return {
    value: value ?? null,
    exclusiveMaximum,
    pass: isNumber(value) ? value < exclusiveMaximum : null,
  };
}

function measuredMinimum(value, minimum) {
  return { value: value ?? null, minimum, pass: isNumber(value) ? value >= minimum : null };
}

function measuredRange(value, minimum, maximum) {
  return {
    value: value ?? null,
    minimum,
    maximum,
    pass: isNumber(value) ? value >= minimum && value <= maximum : null,
  };
}

function requiredBoolean(value) {
  return { value, required: true, pass: value === true };
}

function notApplicable(value, reason) {
  return { value: value ?? null, pass: true, notApplicable: reason };
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
