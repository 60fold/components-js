import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL(
  "../../artifacts/benchmarks/grid/lifecycle-smoke.json",
  import.meta.url,
);

test("lifecycle smoke artifact has valid identity and successful samples", async () => {
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
  assert.equal(artifact.schemaVersion, 4);
  assert.equal(artifact.benchmark, "sixtyfold-grid-production-lifecycle");
  assert.match(artifact.provenance.subjectTree.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.provenance.harnessTree.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.failures, []);
  assert.ok(artifact.samples.length > 0);
  for (const sample of artifact.samples) {
    assert.equal(sample.page.correctness.passed, true);
    assert.equal(sample.page.workerTracking.activeAfterDestroy, 0);
    assertLedger(sample.page);
    assert.deepEqual(sample.page.failures, []);
  }
  assertSuccessfulOutcomes(artifact.outcomes);
});

function assertLedger(page) {
  const ledger = page.exactLedger;
  const permutationBytes = page.profile.rows * Uint32Array.BYTES_PER_ELEMENT;
  const inputCopies = page.configuration.ownership === "transfer" ? 1 : 2;
  const replacementCopies = page.configuration.ownership === "transfer" ? 2 : 3;
  assert.equal(ledger.activeSortPermutationBytes, permutationBytes);
  assert.equal(
    ledger.knownSortScratchBytesLowerBound,
    ledger.workerSortScratchPermutationBytes + ledger.workerRadixCountsBytes,
  );
  assert.equal(
    ledger.sortedSteadyKnownBytesLowerBound,
    ledger.inputTypedArrayBytes * inputCopies + permutationBytes,
  );
  assert.equal(
    ledger.replacementKnownPeakBytesLowerBound,
    ledger.inputTypedArrayBytes * replacementCopies + permutationBytes,
  );
}

function assertSuccessfulOutcomes(outcomes) {
  assert.ok(Array.isArray(outcomes));
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every((outcome) => outcome.status === "completed"));
}
