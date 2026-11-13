---
title: 发布与安装
type: guide
source:
  - scripts/publish-manifest.mjs
  - .npmrc
  - package.json
generated: false
verified: 2026-11-13
---

# 发布与安装

> 读完你会：知道 `@voltojs/*` 发到哪里、谁能装、发布一次要跑哪些命令。

## 发到哪里

`@voltojs/*` 发布到 **GitHub Packages** 的 npm registry：`https://npm.pkg.github.com`。每个可发布包的 `package.json` 里都写着

```json
"publishConfig": { "registry": "https://npm.pkg.github.com" }
```

registry 是按包写的，不是按仓库写的，所以换 registry 不会影响这台机器上其它 npm 包的来源。GitHub Packages 要求**包名里的 scope 与仓库所属账号一致**——这就是 scope 从 `@volto/*` 改成 `@voltojs/*` 的原因，安装命令也相应变成 `npm i @voltojs/sdk`、`npx @voltojs/gateway`。

## 谁能装：私有是默认

GitHub Packages 上发布的包**默认私有**：只有有权限的账号能装，公开的 `npm install` 会拿到 `404`（有时是 `403`）。安装方要做两件事：

1. 用 GitHub 账号生成一个 **personal access token (classic)**，勾选 **`read:packages`**（要发布则另外需要 `write:packages`）；
2. 在**用户级** `~/.npmrc` 里记下 scope 与 token：

```text
@voltojs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxxxxxxx
```

如果不想把 token 明文落在 `~/.npmrc` 里，把环境变量名写进这一行、值放在 shell 配置里（本仓库默认用 `GITHUB_NPM_AUTH_TOKEN`，在 `~/.zshrc` 里 `export`）：

```text
# ~/.npmrc
@voltojs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_NPM_AUTH_TOKEN}
```

```bash
# ~/.zshrc
export GITHUB_NPM_AUTH_TOKEN=ghp_xxxxxxxx
```

**本地和 CI 用的变量名不同**：本地是上面的 `GITHUB_NPM_AUTH_TOKEN`；CI 里由 `actions/setup-node` 的 `registry-url` 往 runner 自己的 `.npmrc` 写 `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`，`release.yml` 把 `NODE_AUTH_TOKEN` 设成 `${{ secrets.GITHUB_TOKEN }}`。两个环境各用各的，不要互相套用。

**仓库里的 `.npmrc` 故意不写任何 token 行**，只声明 scope 映射。项目级配置优先于 `~/.npmrc`，若在里面写 `_authToken=${某个变量}`，那个变量没设时会被展开成空 token，把你 `~/.npmrc` 里的真实凭据覆盖掉——本地发布/安装会因为一条只该写在个人目录里的配置而失败。token 永远不进仓库。

配好后用 npm 自带的身份检查确认这台机器认到了哪个账号：

```bash
npm whoami --registry=https://npm.pkg.github.com
```

你应看到：你的 GitHub 用户名。看到 `401` / `ENEEDAUTH` 说明 token 没被读到或已过期。

`npx` 同样读这份配置——不配 scope 映射的话它会去 npmjs.com 找 `@voltojs/gateway`，然后报 404。装了包之后想跑 `npx @voltojs/gateway`，这台机器上就得一直留着这段配置；它在和你共享这台机器的人之间**不隔离**，见 [安全模型](../../concepts/safety-model.md)。

安装侧的逐步说明在 [安装并启动](../../using/tutorial/01-install.md)。

## 发布一次要做什么

### 1. 仓库在 `voltojs` 组织下

scope 必须与仓库所属账号一致。仓库已经转移到 `voltojs` 组织（`origin` = `git@github.com:voltojs/volto.git`），包的 scope 也已是 `@voltojs`，两者对得上，不需要再做什么。

`repository.url` 也必须指向托管这些包的那个仓库：它由 `scripts/publish-manifest.mjs` 里的 `REQUIRED_METADATA.repository.url` 统一写入每个包的清单。**仓库以后再改地址（再次转移或改名）**时，改这一处，然后

```bash
node scripts/publish-manifest.mjs --write
```

它会把每个包的 `repository` 改写成新 URL，并顺手补齐其它缺失字段；跑一次不带参数的 `node scripts/publish-manifest.mjs` 确认全绿。

### 2. 改版本号

版本用 changesets 管理，所有发布包锁定在同一版本（`.changeset/config.json` 的 `fixed` 列表）。

平时只做第一步：为每次改动写一个 changeset，跟着改动一起提交。

```bash
pnpm changeset                 # 交互式选包 + 选 patch/minor/major，写一个 changeset 文件
```

发版时再把攒下的 changeset 变成版本号。先确保 `~/.npmrc` 里已有上面的 scope 映射与 token（否则 registry 上的新版本号查不到，`changeset version` 报错）：

```bash
pnpm release:version           # pnpm changeset version + 重跑 publish-manifest
git commit -am "chore(release): v0.2.0"
git tag v0.2.0 && git push origin main --tags
```

`@voltojs/*` 之前没有发布过，第一步建议全部从 `0.1.x` 起步（`changeset` 里选 patch）。

### 3. 让包进 GitHub Packages

两条路，选一条：

**本地发布**——需要一个能写包的 token：personal access token (classic) 勾 `write:packages` 就够了（`read:packages` 由它自动带上，`repo` 可以不勾）。最省事的做法是按上文配好本地凭据（`~/.npmrc` 里引用 `GITHUB_NPM_AUTH_TOKEN`），然后直接：

```bash
pnpm release
```

临时用一次也可以只给这条命令设变量（仓库 `.npmrc` 两种情况都不用改）：

```bash
GITHUB_NPM_AUTH_TOKEN=ghp_xxxxxxxx pnpm release
```

`pnpm release` 依次做：从源码全新构建 → 导出 Web 界面 → 校验每个包的清单（含 registry 与残留的 `workspace:` 版本号）→ 校验打包内容 → `pnpm -r publish --no-git-checks`。

**由 GitHub Actions 发布**——`.github/workflows/release.yml` 在推 `v*` 标签或手动触发（Actions → Release → Run workflow）时运行，用仓库自带的 `GITHUB_TOKEN`（工作流里申请的 `packages: write` 权限）认证，不需要另存 secret；它通过 `NODE_AUTH_TOKEN` 传给 pnpm，由 `setup-node` 写进 runner 的 `.npmrc`。它跑 `pnpm install --frozen-lockfile` → `pnpm check:pack` → `pnpm docs:check` → `pnpm -r publish --no-git-checks`。

你应看到：Actions 里 Release 工作流每个步骤都是绿色；仓库的 Packages 页能看到 36 个包的新版本。本地发布看到的是 `pnpm release` 最后逐个包打印的上传结果。

### 4. 选开：让包变成公开

想让不登录 GitHub 也能装（例如 CI 里不想放 token），到包（或组织）的 Packages 设置里把可见性改成 public。截止 2026-11，组织级设置只对之后发布的版本生效，已经发布的版本要逐个改。改之前先确认这个包的源码本来就是公开的。

## 出问题怎么办

- **`403 Forbidden` / `npm ERR! 404 Not Found - PUT`** → 多半是 token 缺少 `write:packages`，或这个账号没有仓库的写权限；先跑 `npm whoami --registry=https://npm.pkg.github.com` 确认 `~/.npmrc` 到底认了谁。scope 与仓库所属账号（`voltojs`）不一致也会这样，但当前仓库已在该组织下，正常不会踩到。
- **`EPUBLISHCONFLICT` / 版本已存在** → 同一个版本号不能覆盖发布；改版本号后重新走第 2 步。
- **Actions 里 install 失败（`404`）** → 工作流所在仓库还没有 `write:packages` 权限，或 `pnpm-lock.yaml` 没随 `package.json` 一起提交。

## 相关

- [把 agent 嵌进自己的宿主](../tutorial/01-embed-agent.md) — 装 `@voltojs/sdk` 要用同一个 `.npmrc`
- [安装并启动](../../using/tutorial/01-install.md) — 用户侧的安装步骤