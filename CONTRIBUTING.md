# Contributing to Sixtyfold Components

Thank you for considering a contribution to Sixtyfold Components.

## Licensing model

Sixtyfold Components is a source-available commercial product of
**Different Planet - Unipessoal Lda.** The public repository is licensed under the
[PolyForm Noncommercial License 1.0.0](https://github.com/60fold/components-js/blob/main/LICENSE.md),
and Different Planet - Unipessoal Lda. also offers the product under separate
commercial and proprietary licenses at [https://sixtyfold.dev](https://sixtyfold.dev).

Contributions accepted into this repository can therefore be used in both the
public noncommercial edition and commercially licensed editions.

## Contributor agreement

Before a pull request can be merged, every contributor must read and accept the
[Sixtyfold Contributor License Agreement Version 1.0](./CONTRIBUTOR_LICENSE_AGREEMENT.md).
You retain ownership of your work. The agreement gives Different Planet - Unipessoal Lda. the
rights needed to modify, distribute, sublicense, and relicense the contribution
under the Project’s public and commercial terms.

Accept the agreement by leaving this statement checked in the pull-request
description:

> I accept the Sixtyfold Contributor License Agreement Version 1.0 for this
> contribution.

The repository’s CLA check verifies that the pull request contains that exact
affirmation. The pull request, its author identity, and its GitHub history form
the acceptance record. A material revision to the agreement will use a new
version and require a new affirmation for later contributions.

If your employer or another organization may own your work, obtain its written
authorization before contributing. Do not accept the agreement on behalf of an
organization unless you are authorized to bind it. Different Planet - Unipessoal Lda. may ask
for a separate corporate authorization before merging the contribution.

## Before opening a pull request

- Search existing issues and pull requests to avoid duplicating work.
- Discuss large API, architecture, data-format, or licensing changes before
  implementation.
- Keep changes focused and include tests appropriate to the behavior changed.
- Preserve worker/main-thread/SSR parity for chart packages and the documented
  architecture of the package being changed.
- Do not commit credentials, private data, generated data artifacts, or
  material copied from a source whose license is incompatible with both public
  and commercial distribution.
- Identify every third-party source and its license in the pull request.

## Before opening an issue

- Use the structured issue form that best matches the report.
- Search existing issues first and link related reports when relevant.
- Provide a minimal reproduction for bugs whenever practical.
- Do not report security vulnerabilities publicly. Follow the private
  instructions in the [security policy](./SECURITY.md).
- Use the [product documentation](https://sixtyfold.dev/en/docs) for setup and
  API guidance before filing a support question.

Opening an issue does not require accepting the contributor agreement. The CLA
applies when you submit a pull request or other material for inclusion in the
repository.

## Development checks

Install dependencies with `pnpm install`. Before requesting review, run the
checks relevant to your change; for most code changes that means:

```bash
pnpm run format
pnpm run build
pnpm run typecheck
pnpm run test:unit
pnpm run check:examples
```

The repository pins Prettier and its rules. Use `pnpm run format` rather than an
editor-specific formatter, and run `pnpm run format:check` to verify that a
working tree is stable. Editors may use the checked-in Prettier and EditorConfig
files without requiring repository-owned personal workspace settings.

Run `pnpm run check:package-release` when package metadata, exports, bundles, or
cross-package dependencies change. See the [README](./README.md) for the
workspace structure and package-specific documentation.

## Pull-request expectations

A pull request should explain:

- what changed and why;
- how it was verified;
- visual evidence for user-interface or rendering changes;
- performance measurements for changes to hot rendering or data paths; and
- the source and license of any incorporated third-party material.

By accepting a contribution, Different Planet - Unipessoal Lda. does not promise that the
change will remain in future versions or that it will be distributed under
every available Sixtyfold license.
