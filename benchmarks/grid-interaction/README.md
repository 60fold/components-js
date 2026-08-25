# Grid interaction benchmark

This suite drives the production worker-mode Grid with browser input and reports
derived latency, presentation cadence, Long Task, geometry, surface-accounting,
and correctness metrics. Raw telemetry and per-frame geometry are computed in
the page but deliberately omitted from the artifact.

```sh
pnpm benchmark:grid -- interaction --help
```

See [the Grid benchmark overview](../grid/README.md) for shared methodology and
commands.
