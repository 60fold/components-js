# Changelog

## 1.0.1 (2026-10-18)

Changes since 1.0.0.

### Security

- Ignore `__proto__`, `constructor`, and `prototype` fields when recursively
  merging chart configuration, including labels and series appearance, to prevent
  prototype pollution from malicious configuration objects.

### Fixes

- Preserve scalar and bulk streaming order across chart batches, snapshot queued
  line samples, and keep chronological data intact after ring-buffer wrap.
- Let Line and Stock LOD hierarchies complete during continuous streaming without
  publishing incomplete levels or retaining stale work after a reset.
- Update line streaming bounds incrementally while retaining correct extrema,
  including stacked series and wrapped buffers.
- Preserve stock market-time viewports when incoming candles change the observed
  cadence, and keep batched range controls and notifications in order.
- Cancel obsolete viewport animations when replacing data or resetting streaming.
- Retain React charts across React 19.2+ `Activity` visibility changes while still
  destroying charts unmounted behind Suspense in React 18 and earlier React 19.
- Make adapter readiness and prop-error recovery consistent; prevent Solid error
  handler loops and update Vue/Svelte `dataUpdateOptions` reactively.
- Stop unnecessary Vue and Angular stats collection when no listener can receive
  events, including consumed Vue `.once` listeners and closed Angular subjects.
- Forward line marker options and stock market-time and price-marker options to
  the SSR renderers.

### Upgrade notes

- Line streaming dimensions must be positive integers and timestamps must be
  finite. Stock streaming requires finite, strictly increasing timestamps and
  aligned OHLCV columns. Invalid appends are rejected before flushing queued
  samples or transferring buffers. See the [Line](./packages/line/README.md#streaming)
  and [Stock](./packages/stock/README.md#streaming) streaming contracts.
- Adapter ready callbacks run after initialization and the first successful prop
  installation, not after a painted frame. Corrected props can recover from a
  rejected installation; renderer failures require a remount.

### Developer tooling

- Align the versioned MCP API catalog and guidance with streaming, adapter
  lifecycle, readiness, and stats-listener behavior.
- Resolve sibling workspace package versions when preparing a single-package
  release.
