# `@sixtyfold/grid`

Worker-first Canvas2D data grid for large typed-column datasets.

This package is under active development. Its first testable runtime combines
the validated typed-column and stable-row-identity kernel with a fixed-row,
resizable-column Canvas2D viewport, presentation row numbers, clickable
two-state header sorting, rectangular selection, keyboard navigation, stable
filtering and multi-sort, logical scrolling beyond browser element height
limits, controlled scalar inline editing, and a bounded virtualized ARIA grid.

## Local preview

The package is not published yet. From the Sixtyfold Components workspace:

```bash
pnpm --filter @sixtyfold/grid build
```

The branded website's `pnpm components:local` command mirrors that build into
its ignored local preview directory. Do not add `@sixtyfold/grid` to a remote
consumer until the package enters the release pipeline.

## Data contract

The package accepts explicit typed buffers for numbers, integers, booleans,
timestamps, dictionary categories, identifiers, and UTF-8 text. Every supplied
buffer declares copy, transfer, or shared ownership independently. Stable row
identity is separate from visual position. `copy` snapshots only each referenced
view range when `setData` is invoked. Transfer-owned buffers are consumed when
the runtime admits the ingress attempt, including when initialization or later
worker-side content validation rejects the dataset. Structural admission errors
such as conflicting ownership are rejected before detachment; use copy
ownership when any failed installation must leave the caller's buffers intact.
Shared buffers must remain immutable until rejection, replacement, or disposal.

## Runtime preview

```ts
import { Grid } from "@sixtyfold/grid";

const grid = new Grid(document.querySelector("#grid")!, {
  ariaLabel: "Operations data",
  renderMode: "auto",
  editing: {
    mode: "controlled",
    async onEditRequest(request) {
      // Validate the proposal before acquiring the commit lease. The editor
      // remains cancellable during this phase.
      if (!mayPersist(request)) {
        return {
          outcome: "rejected",
          code: "business-rule",
          message: "That value is not allowed.",
        };
      }

      // Acquire immediately before the value becomes authoritative. Once
      // granted, the operation cannot be cancelled.
      const lease = await request.beginAuthoritativeCommit();
      if (!lease.granted) {
        return {
          outcome: "rejected",
          code: lease.reason,
          message: lease.message ?? "The cell changed before it could be saved.",
        };
      }

      await persistCell({
        rowId: request.rowId,
        columnId: request.columnId,
        value: lease.finalValue,
      });

      return { outcome: "accepted", leaseId: lease.leaseId };
    },
    onReconcileRequired(event) {
      // The host outcome is uncertain after the point of no return. Reload or
      // replace the dataset before allowing more edits.
      reloadDataset(event);
    },
  },
});

await grid.initialize();
await grid.setData(data);

await grid.setView({
  filter: { kind: "comparison", columnId: "latency", operator: "gte", value: 250 },
  sort: [{ columnId: "latency", direction: "descending", nulls: "last" }],
});
```

Mark supported raw scalar columns with `editable: true` in their schema.
Text, number, integer, boolean, and category cells can be edited; timestamp and
ID cells remain read-only. Double-click a cell, or focus it and press Enter or
F2. Enter saves, Tab saves and advances, clicking another cell saves and moves
there, clicking outside saves without stealing focus back, and Escape cancels
before the commit lease is granted. Accepted edits live in a sparse overlay over
the immutable typed base and are published together with any resulting filter
or sort move.

In supported browsers, `auto` transfers the stable canvas to an
`OffscreenCanvas` paint worker. A separate canonical runtime worker owns the
typed dataset, filter bitmap, stable sort permutation, sparse edit patches, and
cell formatting and exact summary hierarchies. Only bounded visible-cell frames,
aligned row IDs, and explicitly requested summary bands cross back to the host.
The old complete dataset/view/summary stays public until the matching Canvas and
semantic-DOM frame is acknowledged and the runtime publishes the candidate.
`setData`, `setView`, `focusCell`, and `scrollToCell` are therefore asynchronous
publication barriers. `getDiagnostics()` reports whether the canonical runtime
is worker-owned or using the main-thread fallback.

Exact summaries are opt-in and currently support number and dictionary-category
columns:

```ts
const grid = new Grid(host, {
  summary: { columns: ["throughput", "region"] },
});

await grid.setData(data);
const result = await grid.getSummaryBands({
  columnId: "throughput",
  bandCount: 24,
  signal: abortController.signal,
});

if (result.status === "applied" && result.kind === "numeric") {
  const first = result.bands[0];
  if (first?.finiteMaximum) {
    await grid.focusCell({
      rowId: first.finiteMaximum.rowId,
      columnId: result.columnId,
    });
  }
}
```

Each request represents one configured column, accepts at most 2,048 non-empty
bands, and defaults to the complete published active view. Results carry the
renderer-confirmed dataset, data, view, and presentation revisions plus exact
range/count evidence. Numeric extrema and the first four categorical witnesses
retain stable `RowId` provenance; no hierarchy, physical-row permutation, or
column buffer is exposed. A new data, view, or accepted-edit publication resolves an outstanding
old-snapshot query as `superseded`, while an `AbortSignal` rejects with
`AbortError`. B256 hierarchy geometry remains a private runtime detail.
`getDiagnostics()` exposes retained/staged hierarchy bytes, build duration,
query visits, boundary rows scanned, returned vertices/bands, and typed payload
bytes so accidental full scans and budget regressions remain observable.

The summary query API is the data boundary for future summary bands and a
semantic minimap; those visual/assistive interaction surfaces are not included
yet. Clipboard copy/paste, Arrow ingestion, and framework adapters are also not implemented.
Inline editing remains a controlled development slice rather than a complete
spreadsheet editing system: bulk paste, formulas, and timestamp editors remain
out of scope. No assistive-technology qualification claim is attached to this
development slice.

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
