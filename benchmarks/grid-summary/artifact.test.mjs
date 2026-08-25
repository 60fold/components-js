import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL("../../artifacts/benchmarks/grid/summary-smoke.json", import.meta.url);

test("summary smoke artifact has valid identity and successful production-block samples", async () => {
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.benchmark, "sixtyfold-grid-summary-hierarchy");
  assert.match(artifact.provenance.subjectTree.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.provenance.harnessTree.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.failures, []);
  assert.ok(artifact.samples.length > 0);
  for (const sample of artifact.samples) {
    assert.equal(sample.page.correctness.passed, true);
    assert.ok(sample.page.samples.length > 0);
    assert.ok(sample.page.samples.every((entry) => entry.blockSize === 256));
    assert.deepEqual(sample.page.failures, []);
  }
  assertSuccessfulOutcomes(artifact.outcomes);
});

function assertSuccessfulOutcomes(outcomes) {
  assert.ok(Array.isArray(outcomes));
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every((outcome) => outcome.status === "completed"));
}
