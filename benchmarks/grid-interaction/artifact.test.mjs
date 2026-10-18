import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL(
  "../../artifacts/benchmarks/grid/interaction-v2-smoke.json",
  import.meta.url,
);

test("interaction smoke artifact has valid identity and successful samples", async () => {
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.benchmark, "sixtyfold-grid-interaction-pipeline");
  assert.match(artifact.provenance.subjectTree.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.provenance.harnessTree.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.failures, []);
  assert.ok(artifact.samples.length > 0);
  for (const sample of artifact.samples) {
    assert.equal(sample.page.correctness.passed, true);
    assert.deepEqual(sample.page.failures, []);
  }
  assertSuccessfulOutcomes(artifact.outcomes);
});

function assertSuccessfulOutcomes(outcomes) {
  assert.ok(Array.isArray(outcomes));
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every((outcome) => outcome.status === "completed"));
}
