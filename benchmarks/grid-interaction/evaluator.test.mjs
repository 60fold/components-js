import assert from "node:assert/strict";
import test from "node:test";

import { buildInteractionGate, INTERACTION_SCENARIOS } from "./evaluator.mjs";

const canonicalOptions = Object.freeze({
  rowScale: 1,
  scenarios: INTERACTION_SCENARIOS,
  repetitions: 3,
  durationMs: 5_000,
  cadenceHz: 60,
  browser: "chromium",
  dpr: 1,
});

test("compressed-thumb authored spacing is reported but not gated", () => {
  const gate = buildInteractionGate(buildCanonicalSamples(), canonicalOptions, []);

  assert.equal(gate.canonicalEvidencePresent, true);
  assert.equal(gate.achievedDriverLoad, true);
  assert.equal(gate.evaluable, true);
  assert.equal(gate.passes, true);
  assert.equal(
    gate.decision,
    "typescript-worker-surface-pipeline-meets-experimental-interaction-gate",
  );

  const compressedMeasurements = gate.measurements.filter(
    (measurement) => measurement.scenario === "compressed-thumb",
  );
  assert.equal(compressedMeasurements.length, 3);
  for (const measurement of compressedMeasurements) {
    assert.deepEqual(measurement.fields.p95InterPresentationMs, {
      value: 835,
      pass: true,
      notApplicable: "fixed-authored-checkpoint-spacing-is-not-frame-cadence",
    });
    assert.equal(measurement.withinThresholds, true);
  }
});

test("canonical evidence below the sustained driver-load floor is not evaluable", () => {
  const samples = buildCanonicalSamples({ horizontalAchievedIntentHz: 40 });
  const gate = buildInteractionGate(samples, canonicalOptions, []);

  assert.equal(gate.canonicalEvidencePresent, true);
  assert.equal(gate.achievedDriverLoad, false);
  assert.equal(gate.evaluable, false);
  assert.equal(gate.passes, null);
  assert.equal(gate.decision, "insufficient-evidence-driver-load-not-achieved");

  const horizontalMeasurements = gate.measurements.filter(
    (measurement) => measurement.scenario === "horizontal-wheel",
  );
  assert.equal(horizontalMeasurements.length, 3);
  for (const measurement of horizontalMeasurements) {
    assert.deepEqual(measurement.fields.achievedIntentHzMinimum, {
      value: 40,
      minimum: 54,
      pass: false,
    });
  }
});

test("an achieved sustained load with a product threshold miss requests redesign", () => {
  const samples = buildCanonicalSamples({ productLatencyMiss: true });
  const gate = buildInteractionGate(samples, canonicalOptions, []);

  assert.equal(gate.canonicalEvidencePresent, true);
  assert.equal(gate.achievedDriverLoad, true);
  assert.equal(gate.evaluable, true);
  assert.equal(gate.passes, false);
  assert.equal(
    gate.decision,
    "surface-pipeline-redesign-or-optimization-required-before-summary-ui",
  );

  const failedMeasurement = gate.measurements.find(
    (measurement) => measurement.scenario === "vertical-wheel" && measurement.sampleIndex === 0,
  );
  assert.deepEqual(failedMeasurement.fields.p95IntentToPublicationMs, {
    value: 75,
    maximum: 50,
    pass: false,
  });
  assert.equal(failedMeasurement.withinThresholds, false);
});

test("a sustained driver-duration miss is insufficient evidence", () => {
  const gate = buildInteractionGate(
    buildCanonicalSamples({ sustainedDriverDurationMs: 5_600 }),
    canonicalOptions,
    [],
  );

  assert.equal(gate.canonicalEvidencePresent, true);
  assert.equal(gate.achievedDriverLoad, true);
  assert.equal(gate.achievedDriverDuration, false);
  assert.equal(gate.evaluable, false);
  assert.equal(gate.passes, null);
  assert.equal(gate.decision, "insufficient-evidence-driver-duration-not-achieved");
});

test("missing Long Task observer support is insufficient evidence", () => {
  const gate = buildInteractionGate(
    buildCanonicalSamples({ longTaskObserverSupported: false }),
    canonicalOptions,
    [],
  );

  assert.equal(gate.canonicalEvidencePresent, true);
  assert.equal(gate.achievedDriverLoad, true);
  assert.equal(gate.achievedDriverDuration, true);
  assert.equal(gate.longTaskEvidenceAvailable, false);
  assert.equal(gate.evaluable, false);
  assert.equal(gate.passes, null);
  assert.equal(gate.decision, "insufficient-evidence-long-task-observer-unavailable");
});

function buildCanonicalSamples({
  horizontalAchievedIntentHz = 60,
  productLatencyMiss = false,
  sustainedDriverDurationMs = 5_000,
  longTaskObserverSupported = true,
} = {}) {
  return INTERACTION_SCENARIOS.flatMap((scenario) =>
    Array.from({ length: 3 }, (_, sampleIndex) =>
      buildSample({
        scenario,
        sampleIndex,
        achievedIntentHz: scenario === "horizontal-wheel" ? horizontalAchievedIntentHz : 60,
        p95IntentToPublicationMs:
          productLatencyMiss && scenario === "vertical-wheel" && sampleIndex === 0 ? 75 : 5,
        sustainedDriverDurationMs,
        longTaskObserverSupported,
      }),
    ),
  );
}

function buildSample({
  scenario,
  sampleIndex,
  achievedIntentHz,
  p95IntentToPublicationMs,
  sustainedDriverDurationMs,
  longTaskObserverSupported,
}) {
  return {
    page: {
      configuration: {
        scenario,
        sampleIndex,
        durationMs: 5_000,
      },
      correctness: { passed: true },
      trace: { finalSettleMs: 5 },
      metrics: {
        intentToPublicationMs: { median: 3, p95: p95IntentToPublicationMs },
        interPresentationMs: { p95: scenario === "compressed-thumb" ? 835 : 16 },
        rafIntervalMs: { p95: 16 },
        maximumLongTaskDurationMs: 0,
        maximumCanvasSemanticDriftDifferencePx: 0,
        finalSettledVisibleGeometryDriftPx: 0,
        maximumConcurrentSurfaces: 1,
        runtimeCoalescedSurfaceDrops: 0,
        runtimeStaleSurfaceDrops: 0,
        unterminatedRequestedSurfaceCount: 0,
        multiplyTerminatedRequestedSurfaceCount: 0,
        duplicateSurfaceCorrelationCount: 0,
        orphanTerminalSurfaceCount: 0,
        maximumVisibleRows: 24,
        maximumVisibleColumns: 18,
        maximumCellCountProductMismatch: 0,
        longTaskObserverSupported,
        publishedSurfaceCount: scenario === "compressed-thumb" ? 7 : 300,
        achievedIntentHz: scenario === "compressed-thumb" ? null : achievedIntentHz,
        horizontalFarLaneObserved: scenario === "horizontal-wheel" ? true : null,
        horizontalReturnLaneObserved: scenario === "horizontal-wheel" ? true : null,
      },
    },
    runner: {
      inputDriver: {
        actualCommandDurationMs: sustainedDriverDurationMs,
      },
    },
  };
}
