# Grid summary benchmark

This suite measures the production B256 summary hierarchy. It retains exact
raw-oracle validation, structural bounds, cancellation, edit invalidation,
atomic publication, and byte ledgers. Arbitrary and non-power-of-two block
correctness is covered separately by the independent oracle tests.

```sh
pnpm benchmark:grid -- summary --help
```

See [the Grid benchmark overview](../grid/README.md) for shared methodology and
commands.
