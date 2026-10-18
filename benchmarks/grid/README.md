# Grid benchmarks

The Grid has four independent browser benchmark suites. Each runner writes a
JSON artifact under `artifacts/benchmarks/grid/` and records failed attempts—
including timeout, crash, OOM, or unresponsive outcomes—instead of silently
discarding them. Lifecycle, interaction, and summary samples use fresh browser
processes.

| Suite         | Measures                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active-view` | Production-auto filter/sort latency, exact independent-oracle results, cancellation, and typed-array ledgers on narrow 10M-row and wide 1M-row profiles. |
| `lifecycle`   | Materialization, first publication, replacement, sort, responsiveness, ownership, RowIds, worker cleanup, and memory.                                    |
| `interaction` | Real wheel, compressed-scroll, horizontal-scroll, and resize responsiveness through the worker-mode Grid.                                                |
| `summary`     | Production B256 hierarchy build/query latency, structural bounds, cancellation, edit invalidation, publication atomicity, and exact hierarchy bytes.     |

Run a suite with:

```sh
pnpm benchmark:grid -- active-view
pnpm benchmark:grid -- lifecycle
pnpm benchmark:grid -- interaction
pnpm benchmark:grid -- summary
```

Run compact development evidence and all checks with:

```sh
pnpm benchmark:grid:smoke
pnpm benchmark:grid -- check all
```

Use `--help` after a suite name for its workload controls. Full-scale evidence
uses `--row-scale 1`; scaled runs are correctness and harness smoke tests, not
performance claims. Chromium is the canonical gate environment. Firefox and
WebKit are engine qualifications, while installed Firefox and Safari lifecycle
runs are branded-browser observations.

Generated artifacts are not committed. Artifact tests intentionally validate
only identity, schema version, provenance hashes, nonempty successful samples,
and empty failure lists. Independent algorithmic correctness remains in the
source/oracle tests rather than being duplicated in artifact-schema prose.

Performance values depend on hardware, browser version, process state, and test
configuration. Compare artifacts only when their provenance and configuration
match.
