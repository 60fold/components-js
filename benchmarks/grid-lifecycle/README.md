# Grid lifecycle benchmark

This suite measures fresh-process Grid initialization, data ownership and
publication, sort/replacement latency, heartbeat responsiveness, exact
typed-array ledgers, UA-specific memory, and worker teardown. It supports
Playwright engines plus installed Firefox and Safari observations.

```sh
pnpm benchmark:grid -- lifecycle --help
```

See [the Grid benchmark overview](../grid/README.md) for shared methodology and
commands.
