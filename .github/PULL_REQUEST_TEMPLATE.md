## Summary

<!-- What changes, and why. Link the issue if there is one. -->

## User-visible effect

<!-- What a user or integrator can now see or configure. Write "none" if internal. -->

## Verification

- [ ] `pnpm turbo run typecheck lint test --filter <affected-packages>` passes
- [ ] `pnpm docs:check` passes (or `pnpm docs:ack "<reason>"` when no user-visible surface changed)
- [ ] The change is covered by a test that fails without it

## Risk

<!-- Does this touch the core purity invariant, a sandbox boundary, a permission decision,
     a public SDK export or an event shape? If yes, say what you checked. -->