# Volto Desktop

> Volto 的 Electron 原生外壳：界面就是 gateway 托管的 Web UI，凭顶部一条原生外壳栏在本机网关与远程网关之间切换。

桌面端**不再自带 agent、聊天界面或调试面板**。它做四件事：

1. 保存网关档案（本机托管 / 本机直连 / 远程），持久化到 `userData/gateway-profiles.json`；
2. 为本机档案启动并回收一个 gateway 子进程（复用 `apps/gateway/dist/bin.js` 的 CLI 契约）；
3. 探测网关（`/health`、`/`、`/gateway-info`）并维护连接状态；
4. 用两个 `WebContentsView` 展示：44px 本地外壳栏 + 当前网关的 Web UI。

UI 只有一份——gateway 托管的 `apps/web` 导出。切换网关 = 把 content 视图指向另一个 gateway origin，认证沿用 gateway 的 `?token=` → cookie 交换。

## 前置

需要 Node ≥ 22 与 pnpm ≥ 9。本机托管需要仓库里已构建的 gateway 与 Web 导出：

```bash
# 从 monorepo 根
pnpm install
pnpm turbo run build --filter @voltojs/gateway   # 生成 apps/gateway/dist/bin.js
pnpm --filter @voltojs/gateway web:export        # 生成 apps/gateway/web（gateway 托管的 UI）
```

`web:export` 会跑一次 Next 导出并复制到 `apps/gateway/web`；gateway 启动后 `/` 就是这份 UI。

## 开发

```bash
# 从 monorepo 根启动（主进程 + 本地外壳栏热重载）
pnpm --filter @voltojs/desktop-app dev

# 静态门
pnpm --filter @voltojs/desktop-app typecheck
pnpm --filter @voltojs/desktop-app lint
pnpm --filter @voltojs/desktop-app test
pnpm --filter @voltojs/desktop-app build
```

`test` 只覆盖不依赖 Electron 的模块：档案规则、运行时解析、本机进程托管、连接探测、切换状态机。Electron 外壳本身用下面的冒烟脚本验证。

## 使用

### 本机网关（默认）

首次启动自动创建「本机网关」档案：应用以 `--port 0 --no-open` 启动 gateway，从 stdout 读取真实端口与启动令牌，然后加载它。端口随机分配，避免和终端里已经在跑的 `volto` 冲突；两者共用 `~/.volto`（供应商、工作区、会话、令牌都是同一份）。

- **系统 Node ≥ 22 优先**：better-sqlite3 与系统 Node 的 ABI 匹配，会话写 `~/.volto/db/sessions.db`。
- 找不到系统 Node 时回退到 Electron 内置 Node：SQLite 模块 ABI 不匹配，gateway 自动降级到文件 session store；外壳栏/管理页会显示降级警告。
- 想固定端口或连到已运行的本机 gateway：管理页里关掉「由应用启动」，填地址（如 `http://127.0.0.1:3100`）与该网关的访问令牌（`volto token`）。gateway 同样要求鉴权，桌面端不会绕过它。

### 远程网关

1. 在网关机器上运行 `volto`（或 `volto token`）拿到访问令牌；
2. 桌面端管理页 →「添加网关」→ 类型选「远程」→ 填地址与令牌；
3. 保存后点「切换」。

地址只填到端口（`https://gateway.example.com`），不要带路径。远程 token 只保存在主进程，不会进入页面，也不会出现在 `shell:state` 推送里。

### 外壳栏与管理页

- 栏左侧：状态点 + 当前档案名 + `已连接 · v0.2.1`；点击展开管理页。
- 栏右侧：重新加载界面 / 在浏览器中打开（携带一次性令牌）/ 管理网关。
- 菜单「网关」提供同样的切换列表、「管理网关…」（`⌘⇧G`）、「重新连接」。
- 管理页：档案列表、切换、重连、编辑、删除（至少保留一个）、添加；离线时显示错误与重试，降级时显示黄色警告。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `VOLTO_GATEWAY_BIN` | 本机托管的 gateway 入口（`.js` 用 node 跑，否则当可执行文件）。打包版靠它指向外部 gateway。 |
| `VOLTO_NODE` | 启动本机 gateway 用的 node 二进制；必须 ≥ 22。 |
| `VOLTO_DESKTOP_SMOKE` | 冒烟输出目录；启动后等待在线、截图、写 `smoke.json` 并退出。 |
| `VOLTO_DESKTOP_SMOKE_SHEET` | 设为 `1` 时额外截管理页 `sheet.png`。 |
| `VOLTO_DESKTOP_SMOKE_FORM` | 设为 `1` 时点击「添加网关」并截 `form.png`。 |

`VOLTO_CONFIG_DIR` 会被本机 gateway 继承；冒烟时指向临时目录即可不碰真实的 `~/.volto`。

## 冒烟

```bash
cd apps/desktop-app
pnpm build
env -u ELECTRON_RUN_AS_NODE \
  VOLTO_DESKTOP_SMOKE=/tmp/volto-smoke \
  VOLTO_CONFIG_DIR=/tmp/volto-smoke-config \
  node_modules/.bin/electron .
```

产物：`smoke.json`（状态、两个视图的 URL/尺寸、版本）、`shell.png`、`content.png`。截图走 DevTools 协议 `Page.captureScreenshot`，因为 `WebContentsView.capturePage()` 在 macOS 上会报 `Current display surface not available for capture`。

`env -u ELECTRON_RUN_AS_NODE` 是必要的：本仓库的开发环境可能全局设置了它，带上它 Electron 会以纯 Node 方式启动，`app` 不存在。

## 打包

```bash
pnpm --filter @voltojs/desktop-app package:dir     # 未签名 unpacked，验收用
pnpm --filter @voltojs/desktop-app package:mac     # 生成 dmg/zip
```

打包产物目前**不内嵌 gateway 与 web 构建**：远程网关开箱可用；本机托管需要设置 `VOLTO_GATEWAY_BIN` 指向已安装的 `@voltojs/gateway` 的 `dist/bin.js`。内嵌需要先决定 native sqlite 的 Electron ABI 方案（见 `docs/dev/gateway-and-hosts.md` 的桌面端小节）。

## 目录

```
apps/desktop-app/
├── src/
│   ├── shared/           # 类型契约 + 纯档案规则（main 与 renderer 共用，不依赖 electron/node）
│   ├── main/
│   │   ├── index.ts      # 生命周期、单实例、before-quit 回收
│   │   ├── gateway/      # controller / supervisor / runtime / probe / store
│   │   ├── shell/        # window（两个 view）、menu、ipc
│   │   └── smoke.ts      # VOLTO_DESKTOP_SMOKE 时的截图与报告
│   ├── preload/          # 只暴露 window.voltoShell 给本地外壳页
│   └── renderer/         # 外壳栏 + 网关管理页（React + Tailwind）
├── electron-builder.yml
├── electron.vite.config.ts
└── vitest.config.ts
```

## 安全边界

- gateway 内容视图：无 preload、`sandbox: true`、`nodeIntegration: false`、独立 `persist:volto-gateway` 分区；`will-navigate`/`will-redirect` 只放行当前网关 origin，其他 http(s) 交给系统浏览器；`window.open` 一律 deny + 外开；禁用 `<webview>`；权限只放行 `fullscreen` 与 `clipboard-sanitized-write`。
- IPC 只接受外壳页 sender；外壳页是本地产物，不加载远程内容。
- 远程 access token 只存在主进程（`userData/gateway-profiles.json`，与 gateway 自己的 `access-token` 同级信任模型）；后续可换 `safeStorage`。
- 本机 gateway 固定 `--no-open`、只连 loopback、不传 `--serve-remote`。

## 已知边界

- UI 版本跟随网关：连到旧网关看到的就是旧 UI（这正是"复用 web"的代价与收益）。
- 不同网关 origin 的 `localStorage` 隔离，主题等本地偏好不共享；会话/工作区在服务端，不受影响。
- 断线不会自动重连：状态变红 + 手动重试，避免无感重连掩盖令牌失效。
- 切换失败时内容视图会清空（`about:blank`），不会保留上一个网关的界面，避免把消息发到以为已经离开的网关。
- 旧的 `electron-store`（`volto-config.json` 里的 providers/sessions）不再读取，文件原地保留；新配置以 `~/.volto` 为准。