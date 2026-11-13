# Contributing to volto

Thanks for taking the time to contribute. volto is experimental software, so the most
useful contributions are bug reports with a minimal reproduction, focused fixes, and
documentation corrections.

## Before you start

- Read [AGENTS.md](AGENTS.md). It documents the architecture, the core purity invariant,
  the quality gates and the conventions every change must follow.
- Read [SAFETY.md](SAFETY.md) to understand the threat model. Changes that weaken the
  security position (purity, sandbox boundaries, permission semantics) need explicit
  discussion first.
- For anything larger than a typo, open an issue or a draft PR early so we can agree on
  the approach before you invest in a full implementation.

## Development setup

Requirements: Node ≥ 22, pnpm 10, and macOS or Linux (the sandbox has no backend on
Windows).

```bash
pnpm install
pnpm turbo run build
pnpm turbo run typecheck
pnpm turbo run lint
pnpm turbo run test
pnpm docs:check
```

Run only the affected packages while iterating:

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core
```

Always exclude the desktop app; it needs Electron binaries and adds no verification value:

```bash
pnpm turbo run typecheck lint test --filter '!@voltojs/desktop-app'
```

## What to change where

- `packages/core/` — pure decision logic and port interfaces. No I/O, no `Date.now()`,
  no `Math.random()`, no `node:*` imports. The `check-core-zero-deps` gate enforces the
  empty dependency set.
- `packages/tools/*`, `packages/providers/*`, `packages/runtimes/*`,
  `packages/stores/*` — adapters around the ports. Import core types with `import type`.
- `packages/sdk/` and the runners — the executors; they may value-import the pure core.
- `apps/*` — hosts. Wiring only.
- `docs/user/` — user-facing documentation. If your change alters something a user or
  integrator can see or configure, update the docs in the same commit. The writing rules
  are in [docs/user/WRITING.md](docs/user/WRITING.md).

Do not hand-edit generated reference pages (`docs/user/using/reference/tools.md`,
`config.md`, `docs/user/integrating/reference/gateway-api.md`, `sdk-exports.md`). Change
the code or the notes JSON and run `pnpm docs:sync`.

## Tests and quality gates

A change is ready when:

1. `pnpm turbo run typecheck lint test --filter <affected-packages>` passes.
2. `pnpm docs:check` passes when a user-visible surface changed.
3. The change is covered by a test that would fail without it. For sandbox or boundary
   behavior, assert the denial itself (exit code plus the backend's rejection signature),
   not merely empty output.

## Commit and PR conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <summary>`, in English.
- Do not add AI attribution trailers (`Co-Authored-By` naming a model, "Generated with
  …", or equivalent). They are not accepted.
- Keep PRs focused. One logical change per PR; unrelated refactors belong in a separate
  PR.
- Describe the user-visible effect, the test evidence, and any risk to the security
  position.

## License

By contributing you agree that your contributions are licensed under the MIT License
(see [LICENSE](LICENSE)).