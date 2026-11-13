---
title: Publishing and installing
type: guide
source:
  - scripts/publish-manifest.mjs
  - package.json
generated: false
verified: 2026-11-13
---

# Publishing and installing

> After reading this you will: know where `@voltojs/*` is published, who can install it, and which commands a release runs.

## Where it is published

`@voltojs/*` is published to the **public npm registry** (`https://registry.npmjs.org`). Every publishable package's `package.json` contains:

```json
"publishConfig": { "access": "public" }
```

`access: public` is the declaration a scoped package needs to be published publicly: npm treats scoped packages as private (restricted) by default, so without it the publish fails, or others cannot install what you published. You do not need to set the registry; it defaults to npmjs.

## Who can install it

Anyone, with no account, token or extra `.npmrc`:

```bash
npm i @voltojs/sdk
npx @voltojs/gateway
```

Step-by-step instructions from the install side are in [Install and start](../../using/tutorial/01-install.md).

## What a release involves

### 1. The repository lives under the `voltojs` organization

The package scope is `@voltojs`, matching the GitHub organization that hosts the repository. `repository.url` is written into every package manifest by `REQUIRED_METADATA.repository.url` in `scripts/publish-manifest.mjs`. If the repository address ever changes (transfer or rename), change that one place and run:

```bash
node scripts/publish-manifest.mjs --write
```

It rewrites every package's `repository` to the new URL and fills in missing fields; then run `node scripts/publish-manifest.mjs` again with no arguments to confirm everything is green.

### 2. Bump the version

Versions are managed with changesets. `.changeset/config.json` defines two fixed groups — `core`/`tools`/`sdk`/`runtime-node`/`gateway`, and `stores`/`store-sqlite`/`store-postgres` — so each group moves as one version, while `providers` and `memories` version independently. Internal dependencies use `workspace:^`, which pnpm rewrites to a caret range when packing, so cross-group upgrades stay within the same major.

Day to day you only do the first step: write a changeset for each change and commit it together with the change.

```bash
pnpm changeset                 # interactively pick packages + patch/minor/major, write a changeset file
```

At release time, turn the accumulated changesets into version numbers:

```bash
pnpm release:version           # changeset version + re-run publish-manifest
git commit -am "chore(release): v0.2.0"
git tag v0.2.0 && git push origin main --tags
```

### 3. Publish

Two paths; pick one.

**Publish from GitHub Actions (recommended)**: `.github/workflows/release.yml` runs when a `v*` tag is pushed or when triggered manually (Actions → Release → Run workflow). It needs the repository secret `NPM_TOKEN` — a **granular access token** with `Read and write` on the `voltojs` organization and **Bypass two-factor authentication** enabled (npm no longer issues classic automation tokens; without the bypass flag a 2FA-enabled account gets `E403` at publish time). The workflow writes it into `NODE_AUTH_TOKEN`, and `setup-node` places it in the runner's `.npmrc`. The steps are `pnpm install --frozen-lockfile` → `pnpm check:pack` → `pnpm docs:check` → `node scripts/publish-missing.mjs`; the last step publishes only versions the registry does not have yet, so a rerun after a partial failure is safe.

**Publishing locally**: first confirm the credentials on this step:

```bash
npm login --registry=https://registry.npmjs.org
# or write an automation token into the user-level ~/.npmrc:
# //registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

Then:

```bash
pnpm release
```

`pnpm release` does, in order: a clean build from source → export the Web UI → validate every package manifest (`access: public`, leftover `workspace:` version ranges) → validate the packed contents → `pnpm -r publish --no-git-checks`.

You should see: every step green in Actions, and only the changed group's new versions on npm (10 packages are publishable in total); a local release shows the upload result that `pnpm release` prints per package at the end.

### 4. After publishing

`access: public` already makes the packages visible to everyone, so there is no need to change visibility on a settings page. A version number on npm cannot be overwritten; to fix an already published version you can only publish a new patch version.

## When something goes wrong

- **`E401` / `E403`** → the token was not read, has expired, or lacks publish permission. Run `npm whoami --registry=https://registry.npmjs.org` to confirm identity; in Actions, check whether the `NPM_TOKEN` secret exists.
- **`EPUBLISHCONFLICT` / version already exists** → the same version number cannot be published twice; bump the version and redo step 2.
- **install fails in Actions** → most likely `pnpm-lock.yaml` was not committed together with `package.json`.

## Related

- [Embed the agent in your own host](../tutorial/01-embed-agent.md) — install `@voltojs/sdk`
- [Install and start](../../using/tutorial/01-install.md) — installation steps for users