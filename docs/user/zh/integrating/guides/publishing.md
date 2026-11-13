---
title: 发布与安装
type: guide
source:
  - scripts/publish-manifest.mjs
  - package.json
generated: false
verified: 2026-11-13
---

# 发布与安装

> 读完你会：知道 `@voltojs/*` 发到哪、谁能装、发布一次要跑哪些命令。

## 发到哪里

`@voltojs/*` 发布到 **npm 公共 registry**（`https://registry.npmjs.org`）。每个可发布包的 `package.json` 里写着：

```json
"publishConfig": { "access": "public" }
```

`access: public` 是 scoped 包公开发布的必要声明：npm 默认把 scoped 包当作私有（restricted），缺了它发布会失败，或者发出来别人装不到。registry 不用写，默认就是 npmjs。

## 谁能装

任何人，不需要账号、token 或额外的 `.npmrc`：

```bash
npm i @voltojs/sdk
npx @voltojs/gateway
```

安装侧的逐步说明在 [安装并启动](../../using/tutorial/01-install.md)。

## 发布一次要做什么

### 1. 仓库在 `voltojs` 组织下

包名 scope 是 `@voltojs`，与托管仓库的 GitHub 组织一致。`repository.url` 由 `scripts/publish-manifest.mjs` 里的 `REQUIRED_METADATA.repository.url` 统一写入每个包的清单。仓库以后改地址（转移或改名）时，改这一处再跑：

```bash
node scripts/publish-manifest.mjs --write
```

它会把每个包的 `repository` 改写成新 URL 并补齐缺失字段；再跑一次不带参数的 `node scripts/publish-manifest.mjs` 确认全绿。

### 2. 改版本号

版本用 changesets 管理，所有发布包锁定在同一版本（`.changeset/config.json` 的 `fixed` 列表）。

平时只做第一步：为每次改动写一个 changeset，跟着改动一起提交。

```bash
pnpm changeset                 # 交互式选包 + 选 patch/minor/major，写一个 changeset 文件
```

发版时把攒下的 changeset 变成版本号：

```bash
pnpm release:version           # changeset version + 重跑 publish-manifest
git commit -am "chore(release): v0.2.0"
git tag v0.2.0 && git push origin main --tags
```

### 3. 发布

两条路，选一条。

**由 GitHub Actions 发布（推荐）**：`.github/workflows/release.yml` 在推 `v*` 标签或手动触发（Actions → Release → Run workflow）时运行。它需要仓库 secret `NPM_TOKEN`——npm 账号的 **Automation** token（勾选 publish 权限；账号开了 2FA 时普通 token 发布会要求 OTP，automation token 不受影响）。工作流把它写入 `NODE_AUTH_TOKEN`，`setup-node` 负责把它放进 runner 的 `.npmrc`。步骤依次是 `pnpm install --frozen-lockfile` → `pnpm check:pack` → `pnpm docs:check` → `pnpm -r publish --no-git-checks`。

**本地发布**：先在这一步确认凭据：

```bash
npm login --registry=https://registry.npmjs.org
# 或者把 automation token 写进用户级 ~/.npmrc：
# //registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

然后：

```bash
pnpm release
```

`pnpm release` 依次做：从源码全新构建 → 导出 Web 界面 → 校验每个包的清单（`access: public`、残留的 `workspace:` 版本号）→ 校验打包内容 → `pnpm -r publish --no-git-checks`。

你应看到：Actions 里每一步都是绿色，npm 上 36 个包出现新版本；本地发布看到的是 `pnpm release` 最后逐个包打印的上传结果。

### 4. 发布之后

`access: public` 已经让包对所有人可见，不需要再去设置页改可见性。npm 上同一版本号不能覆盖；要修一个已发布的版本，只能发一个新的 patch 版本。

## 出问题怎么办

- **`E401` / `E403`** → token 没被读到、过期，或没有发布权限。跑 `npm whoami --registry=https://registry.npmjs.org` 确认身份；Actions 里检查 `NPM_TOKEN` secret 是否存在。
- **`EPUBLISHCONFLICT` / 版本已存在** → 同一个版本号不能重复发布；改版本号后重新走第 2 步。
- **Actions 里 install 失败** → 多半是 `pnpm-lock.yaml` 没随 `package.json` 一起提交。

## 相关

- [把 agent 嵌进自己的宿主](../tutorial/01-embed-agent.md) — 装 `@voltojs/sdk`
- [安装并启动](../../using/tutorial/01-install.md) — 用户侧的安装步骤