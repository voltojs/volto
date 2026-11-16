---
title: Release and publishing
status: current
source:
  - .changeset/config.json
  - .github/workflows/release.yml
  - scripts/publish-manifest.mjs
  - scripts/publish-missing.mjs
  - package.json
verified: 2026-11-16
---

# Release and publishing

> **Maintainer-only.** Publishing is controlled by the maintainer; this page is not part
> of the user documentation and is not published to the docs site. Contributors do not
> run releases and do not need npm credentials.

This page records how a `@voltojs/*` release is cut, so the mechanics are written down
somewhere other than one person's memory. It is developer documentation: nothing here is
a promise to package consumers.

## What is published

Ten packages ship to the **public npm registry** (`https://registry.npmjs.org`):

`@voltojs/core`, `@voltojs/tools`, `@voltojs/memories`, `@voltojs/providers`,
`@voltojs/stores`, `@voltojs/store-sqlite`, `@voltojs/store-postgres`,
`@voltojs/runtime-node`, `@voltojs/sdk`, `@voltojs/gateway`.

`@voltojs/eval`, `@voltojs/runtimes-web`, `@voltojs/web` and `@voltojs/desktop-app` are
`private` and never publish. Every publishable `package.json` carries
`"publishConfig": { "access": "public" }`: npm treats a scoped package as restricted by
default, so without that declaration the publish is rejected (or nobody could install
it). The registry itself is never configured — npmjs is the default.

## Scope and repository

The `@voltojs` scope belongs to the `voltojs` npm organization, which matches the GitHub
organization hosting the repository. `repository.url` is written into every manifest by
`REQUIRED_METADATA.repository.url` in `scripts/publish-manifest.mjs`. If the repository
moves, change that one place and run:

```bash
node scripts/publish-manifest.mjs --write   # rewrite every manifest
node scripts/publish-manifest.mjs           # confirm everything is green
```

## Versioning

Versions are managed with changesets. `.changeset/config.json` defines two `fixed` groups:

| Group | Members |
| --- | --- |
| kernel and hosts | `core`, `tools`, `sdk`, `runtime-node`, `gateway` |
| storage | `stores`, `store-sqlite`, `store-postgres` |

Group members always share a version, because they share a contract (ports and tool
definitions in the first case, the `SessionStore` contract in the second). `providers`
and `memories` are outside both groups and version independently — their contracts evolve
on their own schedule.

Internal dependencies use `workspace:^`. pnpm rewrites that to a caret range when
packing, so a consumer installing `@voltojs/sdk@0.3.0` accepts `@voltojs/tools@^0.3.0`
but not a different minor, which is what keeps cross-group upgrades inside one major.

## Cutting a release

### 1. Write changesets as you go

Every change that affects a shipped package carries a changeset, committed with the
change:

```bash
pnpm changeset      # pick packages + patch/minor/major
```

### 2. Turn changesets into versions

```bash
pnpm release:version       # changeset version + publish-manifest
pnpm install               # refresh pnpm-lock.yaml
git add -A && git commit -m "chore(release): v0.3.0"
git tag v0.3.0 && git push origin main --tags
```

`release:version` runs `changeset version` and then re-runs the manifest gate, so a
release never starts from manifests that fail the publishing contract.

### 3. Publish

Pushing the `v*` tag triggers `.github/workflows/release.yml`, which can also be started
by hand (Actions → Release → Run workflow). Authentication is **npm trusted publishing
(OIDC)**: no `NPM_TOKEN` secret exists, and no long-lived token lives in the repository.
The job declares `id-token: write`; the npm CLI exchanges that short-lived workflow
identity for publish rights.

Each of the ten packages needs a trusted publisher configured once on npmjs.com
(package → Settings → Trusted Publisher → GitHub Actions):

| Field | Value |
| --- | --- |
| Organization or user | `voltojs` |
| Repository | `volto` |
| Workflow filename | `release.yml` |
| Environment name | **empty** — the workflow declares no environment, and a configured name makes the OIDC claim mismatch |
| Allowed actions | **`npm publish`**, plus `npm dist-tag` |

`npm stage publish` alone is not enough: this workflow publishes directly. A freshly
configured trusted publisher must complete one publish within two days or npm discards
the configuration.

The job runs `npm install -g npm@latest` (trusted publishing needs npm ≥ 11.5.1) →
`pnpm install --frozen-lockfile` → `pnpm check:pack` → `pnpm docs:check` →
`node scripts/publish-missing.mjs`.

`publish-missing.mjs` publishes only versions the registry does not have yet, in
dependency order. It packs each package with `pnpm pack` — which rewrites `workspace:^`
into a real semver range — and uploads the tarball with `npm publish`, because `pnpm
publish` does not implement npm's OIDC detection. Rerunning after a partial failure is
safe: published versions are skipped.

### 4. Publishing locally

Trusted publishing only works from a CI workflow, so a local release needs a token:

```bash
npm login --registry=https://registry.npmjs.org
# or reference a granular access token (Read and write on `voltojs`, Bypass 2FA)
# from the user-level ~/.npmrc:
# //registry.npmjs.org/:_authToken=${NPM_AUTH_TOKEN}
pnpm release
```

`pnpm release` does, in order: a clean build from source → export the Web UI → validate
every manifest → validate the packed contents → publish the missing versions.

## After publishing

`access: public` already makes the packages installable by anyone, so no settings page
needs changing. A published version cannot be overwritten; fixing a broken release means
publishing a new patch version. Unpublishing is possible for a short window after the
fact and is otherwise not an option — prefer a forward fix.

## When something goes wrong

- **`E401` / `E403` locally** → the token was not read, has expired, or lacks publish
  permission. Run `npm whoami --registry=https://registry.npmjs.org`.
- **`E403` in Actions with OIDC configured** → check all three: the trusted publisher
  allows `npm publish` (not only `npm stage publish`), the CLI is ≥ 11.5.1, and no
  `_authToken` line reaches the runner's `.npmrc` — any configured token makes npm skip
  OIDC. `setup-node`'s `registry-url` input writes one, which is why the workflow does
  not pass it.
- **`E429`** → registry rate limiting on the account, not a permission problem. It
  applies to CI and local runs alike; wait it out instead of retrying in a tight loop.
- **`EPUBLISHCONFLICT` / version already exists** → a version number can only be
  published once; bump and redo step 2.
- **Install fails in Actions** → most likely `pnpm-lock.yaml` was not committed with
  `package.json`.

## Related

- [docs-system.md](docs-system.md) — how the user documentation is generated and checked
- [architecture.md](architecture.md) — the package layout this release set mirrors