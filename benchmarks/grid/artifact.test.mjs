import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL("../../artifacts/benchmarks/grid/hardened-smoke.json", import.meta.url);

test("active-view smoke artifact has valid identity and successful samples", async () => {
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.benchmark, "sixtyfold-grid-active-view");
  assert.match(artifact.provenance.subjectTree.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.provenance.harnessTree.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.failures, []);
  assert.ok(artifact.profiles.length > 0);
  for (const profile of artifact.profiles) {
    assert.ok(profile.samples.length > 0);
    assert.ok(profile.builderCancellation.length > 0);
    assert.equal(profile.correctness.exactResultValidationPassed, true);
    assert.deepEqual(profile.failures, []);
  }
  assertSuccessfulOutcomes(artifact.outcomes);
});

function assertSuccessfulOutcomes(outcomes) {
  assert.ok(Array.isArray(outcomes));
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every((outcome) => outcome.status === "completed"));
}
