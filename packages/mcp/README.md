# `@sixtyfold/mcp`

A local, read-only Model Context Protocol server that gives coding agents
version-aware access to Sixtyfold package selection, public APIs, framework
examples, option checks, performance guidance, and diagnostics.

The server is developer tooling. It is not imported by chart applications and
does not increase the browser bundle size of `@sixtyfold/line`,
`@sixtyfold/stock`, or any framework adapter.

## Connect

Configure an MCP host to launch the npm package over `stdio`:

```json
{
  "mcpServers": {
    "sixtyfold": {
      "command": "npx",
      "args": ["-y", "@sixtyfold/mcp@1"]
    }
  }
}
```

You can also install it explicitly:

```bash
pnpm add --global @sixtyfold/mcp@1
sixtyfold-mcp
```

The process writes only MCP JSON-RPC messages to standard output. It requires no
Sixtyfold account, API key, or hosted service.

## Tools

| Tool                             | Purpose                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `list_packages`                  | List independent packages, versions, and entry points                                                                |
| `inspect_component_api`          | Search exact TypeScript symbols, members, signatures, and documented failure contracts within a fixed context budget |
| `recommend_packages`             | Return the smallest engine, wrapper, theme, and SSR package set                                                      |
| `generate_integration`           | Produce verified framework code and optionally adapt a described row or column data shape into typed arrays          |
| `validate_chart_options`         | Preflight top-level line or stock construction options                                                               |
| `recommend_performance_settings` | Suggest grounded render-mode, LOD, and transfer defaults                                                             |
| `diagnose_chart`                 | Focus debugging for LOD, lifecycle, buffer, memory, and rendering symptoms                                           |

All tools declare read-only, non-destructive, idempotent behavior. The server
does not modify project files or execute arbitrary shell commands.

On connection the server sends `instructions` describing the intended tool order
and the three integration mistakes that cause most broken charts, so a host does
not have to be told how to drive it.

## Context budget

Agent context is the scarce resource, so responses are bounded by construction:

- `inspect_component_api` returns the members that match the query, not every
  member of the parent type. A hit on one property of a 289-member React props
  interface returns that property, plus `memberCount`, `membersOmitted`, and the
  `membersResource` URI to read for the rest. Export- and member-level `throws`
  fields preserve documented failure contracts from the declarations.
- An export matched only incidentally returns no members at all; an export
  matched by its own name returns a bounded preview.
- Each matching export defaults to at most 12 members; override that per-result
  limit with `maxMembers`. A single search remains capped at 40 members in total
  across all results.
- Inlined structural signatures are capped at 400 characters and flagged with
  `signatureTruncated`. Read `sixtyfold://api/{packageName}` for the full type.

A regression test asserts the worst-case search stays inside that budget.

## Resources and prompts

The server exposes a compact package catalog, typed-array ownership guidance,
performance guidance, minimal licensing guardrails at
`sixtyfold://guides/licensing`, and package-specific API resources under
`sixtyfold://`. User-selectable prompts cover adding, tuning, and reviewing a
Sixtyfold integration.

The bundled licensing resource identifies the public licence and the point at
which commercial terms are required. It deliberately leaves plans, prices,
scope, refunds, support, and version coverage to the live pricing and legal
pages. Reading it makes no network request.

The bundled API inventory is generated from the same declaration files shipped
by the component packages. CI fails when it drifts from those public entry
points.

Integration notes also describe adapter readiness and prop-error recovery,
React Activity visibility, Vue once-only stats collection, and Angular stats
subscriptions. Timestamp diagnostics distinguish strictly increasing stock
streaming from normalized static history; stock append validation happens
before buffer transfer.

## Privacy and network behavior

`@sixtyfold/mcp` is local-first:

- `stdio` transport only in version 1;
- no telemetry or analytics;
- no remote documentation fetch;
- no account, activation, or runtime phone-home;
- no customer chart data leaves the machine through this server.

The selected MCP host and model may have their own data-handling behavior.
Review that host separately before supplying proprietary code or data.

## Licensing

This package is source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

For current licensing, commercial terms, and prices, see
[Licensing and Commercial Terms](https://sixtyfold.dev/en/commercial-terms)
and [Pricing](https://sixtyfold.dev/en/pricing).
