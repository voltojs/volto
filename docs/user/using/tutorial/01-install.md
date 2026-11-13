---
title: 安装并启动
type: tutorial
source:
  - apps/gateway/src/cli.ts
  - apps/gateway/src/bin.ts
  - apps/gateway/src/auth/browser-auth.ts
  - apps/gateway/src/config/paths.ts
generated: false
verified: 2026-11-13
---

# 安装并启动

> 读完你会：用一条 `npx` 命令把网关和 Web 界面跑起来，并在浏览器里登录进去。

## 前提

- **Node.js ≥ 22**（`node -v` 确认；装不上就是这一条，不会有别的报错）
- **macOS 或 Linux**。Windows 及其它没有沙箱后端的平台目前**起不来网关**：默认档位要求隔离，缺失后端时会直接拒绝启动（详见 [沙箱与平台](../guides/sandbox-and-platforms.md)）
- **能读到这个包的权限**。`@voltojs/*` 发布在 GitHub Packages（`https://npm.pkg.github.com`），默认是**私有**包：没有访问权限的账号装不到，会看到 `404` 或 `403`。权限与下面的 token 是同一个问题，见 [发布与安装](../../integrating/guides/publishing.md)。

## 步骤

### 1. 配好 GitHub Packages 的登录

`npx` 也走同一个 `.npmrc`：npx 会按包名里的 scope（`@voltojs`）去找对应的 registry，没有这条配置就会去 npmjs.com 上找，然后报 `404 Not Found`。

1. 在 GitHub **Settings → Developer settings → Personal access tokens → Tokens (classic)** 生成一个 token，勾选 **`read:packages`** 这一个 scope（只要装包的话，`repo` 也不用勾）。
2. 把两行写进 `~/.npmrc`：

```text
@voltojs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<你的 token>
```

或者只写 registry 这一行，把 token 交给环境变量：

```bash
export NODE_AUTH_TOKEN=<你的 token>
```

同时写了两处时，`.npmrc` 里写死的那行优先。

你应看到：`ls ~/.npmrc` 能看到这个文件，且里面那行 `@voltojs:registry` 没有被注释掉。

### 2. 启动

```bash
npx @voltojs/gateway
```

第一次运行会下载这个包，稍等几秒。网关**同时提供 API 和 Web 界面**，不需要再开第二个终端、也不需要单独启动前端。

你应看到**只有两行**：

```text
volto gateway 0.1.0 listening on http://127.0.0.1:3100
Open: http://127.0.0.1:3100/?token=…
```

版本号与端口可能和上面不同，两行的形状不变。启动成功的提示只有这两行，别的提示都走错误输出（stderr），脚本可以放心解析标准输出。

这两行是**默认子命令 `serve`**（也就是不带子命令）的输出。`volto token` 打印的是 token 加一条 `Open:` 链接，也是两行；`volto web`（见 [远程访问](../guides/remote-access.md#开第二个前端可选)）是**三行**——前两行形状同上，第三行 `Login:` 带的是持久 token。

本机运行时会自动用默认浏览器打开 `Open:` 那一行；不想让它弹，加 `--no-open`，此时那一行就是你要手动粘进浏览器的地址。

### 3. 登录

把 `Open:` 后面那个网址粘进浏览器（它已经跳到了聊天界面，就不用再粘）。

这个网址里的 `token=` 是一次性凭据：打开后它会被换成 cookie，然后地址栏跳回干净的 `/`，token 不会留在地址栏里。

你应看到：聊天界面，左侧会话列表为空，输入框在窗口底部。

### 4. 确认登录还在

关掉这个终端会连网关一起停掉。重开时再跑一次 `npx @voltojs/gateway`，**直接用浏览器打开 `http://127.0.0.1:3100/`**（不带 token）就行——上一步换到的 cookie 还在，7 天内有效。

新启动的进程打印的 `Open:` 链接随时也能用，它是另一种登录方式。

## 常用参数

```bash
npx @voltojs/gateway --port 3200            # 换端口（打印的两行会跟着变）
npx @voltojs/gateway --no-open              # 不自动开浏览器
npx @voltojs/gateway --config-dir /tmp/v    # 换配置目录，默认 ~/.volto
npx @voltojs/gateway --help                 # 所有参数
```

子命令可写可不写：不带子命令就是启动网关（等价于 `volto serve`），另有 `token` / `doctor` / `web` 三个子命令。检查这台机器能不能跑：

```bash
npx @voltojs/gateway doctor
```

它逐行打印六项检查（`node version` / `sandbox backend` / `sandbox binary` / `config dir` / `sqlite` 与端口），每项状态是 `ok` / `warn` / `fail`。**只有硬性条件不满足才以退出码 1 结束**；端口被占用、会话库退回文件存储这类只是提示，不影响启动。

## 登录不上时

- **页面 401 或一直停在登录** → 网关重启过，旧的 `token=` 链接会失效（每次启动都会生成新的）。用本次启动打印的 `Open:` 链接，或确认浏览器里还有上一步的 cookie。
- **`npx` 报 `404 Not Found` 或 `403`** → 上一步的 `.npmrc` 没写到当时用的那个用户目录（`sudo` 下是 root 的 `~`），或 token 过期、没勾 `read:packages`、账号没有这个包的访问权限。用 `npm whoami --registry=https://npm.pkg.github.com` 确认登录的是哪个账号。
- **终端出现 `Could not listen on 127.0.0.1:3100: EADDRINUSE`** → 3100 已被占用：先停掉旧进程，或换个端口（见上面的换端口参数）。这种情况**不会打印** `volto gateway … listening on …` 和 `Open: …` 这两行，标准输出是空的，只有这一条报错，退出码 1。
- **启动即退出，终端里没有被上面几条覆盖的报错** → 跑一次 `npx @voltojs/gateway doctor`，失败的硬性项就是原因。

更多症状见 [故障排查](../guides/troubleshooting.md)。

## 从源码运行 / 给贡献者

clone 仓库后（需要 pnpm 10）：

```bash
pnpm install
pnpm turbo run build
pnpm web:export                 # 导出 Web 静态界面
node apps/gateway/dist/bin.js
```

`pnpm web:export` 只把界面导出到 `apps/web/out`；网关默认读的 `web/` 目录是发布打包时才生成的，仓库里没有。所以只跑上面三条，打开页面会看到「界面找不到」。想让它直接伺服刚导出的构建，用 `--web-dir` 指过去：

```bash
node apps/gateway/dist/bin.js --web-dir apps/web/out
```

Web 前端和网关也可以像以前一样分开跑（开发前端时最顺手），两者端口不同，要让网关接受来自前端的跨源请求：

```bash
# 终端 1：网关（默认就认 http://localhost:6100 这个开发地址；换端口时要显式设）
VOLTO_CORS_ORIGINS=http://localhost:6100 node apps/gateway/dist/bin.js
# 终端 2：前端开发服务器
cd apps/web && pnpm dev
```

「界面一个端口、API 转发回网关」的生产形态用 `npx @voltojs/gateway web`，见 [远程访问](../guides/remote-access.md#开第二个前端可选)。

## 下一步

[配置模型，开始第一次对话](./02-first-conversation.md)

要把它放到自己的浏览器之外（手机、另一台电脑、隧道），见 [远程访问](../guides/remote-access.md)。