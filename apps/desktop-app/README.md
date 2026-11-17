# Volto Desktop

> Volto 的 Tauri 原生外壳：主窗口始终显示**当前网关自己的 Web UI**，桌面端只负责启动/连接网关、保存网关档案和切换。

桌面端不复刻任何聊天界面，也不自带 agent：

- **主窗口**：一个 webview，加载当前网关托管的 UI（`http://<gateway>/`）。切换网关 = 让这个 webview 重新导航。
- **设置窗口**：一个本地 webview，渲染 React 设置页（网关列表、新增/编辑/删除、离线状态与重试）。它是**唯一**能调用 Rust 命令的 webview。
- **原生菜单**：网关列表（当前项勾选）、管理网关…（`⌘⇧G`）、重新连接、在浏览器中打开；
  「视图」里可切换主题（跟随系统/浅色/深色）和语言（中文/English）。
- **macOS 窗口**：隐藏原生标题栏（`Overlay`），红绿灯浮在左侧边栏上方，右侧内容占满高度；
  边栏顶部预留 44px 拖拽/红绿灯区，侧栏收起时右侧头部左侧让出红绿灯位置。
- 窗口标题实时显示「Volto Desktop · 档案名 · 已连接/连接中/未连接」（随语言切换）。

## 前置

- Node ≥ 22（本机托管网关用；Tauri 不自带 Node）
- 系统 `curl`（探测网关用；macOS/Linux/Windows 自带）
- pnpm ≥ 9；开发/构建还需要 Rust 工具链
- gateway 与 web 构建（本机托管需要）：

```bash
# 从 monorepo 根
pnpm install
pnpm turbo run build --filter @voltojs/gateway   # 生成 apps/gateway/dist/bin.js
pnpm --filter @voltojs/gateway web:export        # 生成 apps/gateway/web（gateway 托管的 UI）
```

## 开发

```bash
pnpm --filter @voltojs/desktop-app dev        # tauri dev（Vite 在 1420）
pnpm --filter @voltojs/desktop-app dev:web    # 只跑 Vite，浏览器里看设置页（预览模式）
pnpm --filter @voltojs/desktop-app typecheck
pnpm --filter @voltojs/desktop-app lint
pnpm --filter @voltojs/desktop-app build:web
pnpm --filter @voltojs/desktop-app test:rust  # cargo test
```

`tauri dev` 需要 `src-tauri` 依赖可解析；离线环境用 `CARGO_NET_OFFLINE=true pnpm ...`。

## 使用

### 本机网关（默认）

首次启动自动创建「本机网关」档案：应用用 `--port 0 --no-open` 启动 `apps/gateway/dist/bin.js`，从 stdout 读取真实端口与启动令牌，再让主窗口加载它。与终端里的 `volto` 共用 `~/.volto`（供应商、工作区、会话、令牌同一份）。

- Node 发现顺序：`VOLTO_NODE` → `PATH` → 登录 shell（Finder 启动的 GUI 应用 PATH 通常不含 fnm/homebrew）→ 报错（提示安装 Node 或设置 `VOLTO_NODE`）。
- 入口发现顺序：`VOLTO_GATEWAY_BIN` → 资源目录 `gateway/bin.js`（预留）→ 应用目录的 `../gateway/dist/bin.js` → 登录 shell 的 `volto`。
- 想固定端口或连到已运行的 gateway：设置窗里关掉「由应用启动」，填地址与该网关的访问令牌（`volto token`）。
- 网关报 SQLite 不可用时，设置页会显示降级提示（会话落到文件存储）。

### 远程网关

在网关机器上运行 `volto token` 拿令牌 → 设置窗「添加网关」→ 类型「远程」→ 填地址（只到端口）与令牌 → 保存并切换。

远程网关必须允许来自本机桌面应用的请求；桌面端用 Bearer 令牌访问 API，但仍要求网关本身可达且 origin 放行策略允许该 `Origin`。若对方部署无法调整，使用本机网关或在浏览器里直接打开网关。

### 状态与失败

- 主窗口在连接时显示「正在连接网关…」，失败时显示「还没有连上网关」，并自动打开设置窗显示具体错误与「重试」。
- 切换失败不会保留上一个网关的界面：主窗口会清空到静态页，避免把消息发到以为已经离开的网关。
- 断线不自动重连；用设置窗的「重连」或菜单「网关 → 重新连接」。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `VOLTO_GATEWAY_BIN` | 本机托管的 gateway 入口（`.js` 用 node 跑，否则当可执行文件） |
| `VOLTO_NODE` | 启动本机 gateway 的 node 二进制；必须 ≥ 22 |
| `VOLTO_CURL` | 探测用的 curl 二进制（默认 `curl`） |
| `VOLTO_DESKTOP_SMOKE` | 冒烟输出目录：等待连接终态、写 `smoke.json`、退出 |
| `VOLTO_DESKTOP_SMOKE_PROFILE` | 冒烟时新增并切换到该档案（JSON：`{label,kind,url,token?}`） |
| `VOLTO_DESKTOP_SMOKE_SETTINGS` | 设为 `1` 时打开设置窗并把它的 DOM 摘要写进报告 |
| `VOLTO_DESKTOP_SMOKE_THEME` | `system` / `light` / `dark`，冒烟前写入偏好 |
| `VOLTO_DESKTOP_SMOKE_LOCALE` | `zh` / `en`，冒烟前写入语言 |
| `VOLTO_DESKTOP_SMOKE_TOGGLE` | 设为 `1` 时在写报告前切到 light + 中文，验证运行时切换 |
| `VOLTO_CONFIG_DIR` | 被本机 gateway 继承；冒烟可指向临时目录 |

## 冒烟

```bash
cd apps/desktop-app
pnpm build:web
pnpm tauri build --debug --no-bundle     # 或 release: pnpm tauri build --no-bundle

# 1) 本机真实 gateway
env VOLTO_DESKTOP_SMOKE=/tmp/volto-smoke \
    VOLTO_CONFIG_DIR=/tmp/volto-smoke-config \
    src-tauri/target/debug/volto-desktop

# 2) 假 gateway（远程链路 + 请求日志）
pnpm smoke:gateway &                     # 127.0.0.1:4597
env VOLTO_DESKTOP_SMOKE=/tmp/volto-smoke-remote \
    VOLTO_DESKTOP_SMOKE_SETTINGS=1 \
    VOLTO_DESKTOP_SMOKE_PROFILE='{"label":"假网关","kind":"remote","url":"http://127.0.0.1:4597","token":"smoke-token"}' \
    src-tauri/target/debug/volto-desktop
```

产物：`smoke.json`（状态、档案、主窗口 URL/标题、设置窗 URL/标题、设置页 DOM 摘要，
以及主窗口页面自检 `pageReport`：`lang`、`theme`、`shell`、`dark`、拖拽区数量）。假 gateway 的日志（`/tmp/fake-gateway.log`）能证明主窗口真的请求并渲染了它的页面。

> `tauri build --debug` 仍被视为 dev 模式（`WebviewUrl::App` 指向 `devUrl`）。要验证内嵌资源与真实打包行为，用 release 构建。

## 目录

```
apps/desktop-app/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs        生命周期、单实例锁、菜单事件、退出回收
│   │   ├── windows.rs     主窗口（网关 UI/静态页）与设置窗
│   │   ├── commands.rs    IPC 命令、连接 worker、冒烟辅助
│   │   ├── menu.rs        原生菜单（纯模型 + Tauri 构建）
│   │   ├── controller.rs  网关状态机（无 Tauri 依赖）
│   │   ├── profiles.rs    档案类型与纯规则
│   │   ├── store.rs       档案持久化（0600 + 原子写）
│   │   ├── runtime.rs     Node 与 gateway 入口解析
│   │   ├── supervisor.rs  本机 gateway 子进程
│   │   └── probe.rs       基于 curl 的连通性/鉴权探测
│   ├── capabilities/default.json  只有 settings webview 有 IPC
│   └── tauri.conf.json
├── src/renderer/          设置页（React + Tailwind）+ 静态 connecting/offline 页
└── scripts/smoke-gateway.mjs
```

## 安全边界

- 主窗口加载远程网关页面，**没有 IPC 权限**（capability 只给 `settings`）；命令还会校验调用方 label。
- 设置窗只加载本地资源，`on_navigation` 只放行应用 origin。
- 访问令牌只存在 Rust 内存与 `gateway-profiles.json`（0600）；`ShellState` 只暴露 `hasToken`；curl 探测通过 0600 临时配置文件传 token，不出现在 argv。
- 主窗口导航白名单只含应用 origin 与当前网关 origin；其他 http(s) 交给系统浏览器。
- 本机 gateway 固定 `--no-open`、只连 loopback、不传 `--serve-remote`。

## 已知边界

- UI 版本跟随网关：连到旧网关看到的就是旧 UI；旧版 web 不认 `volto_shell/volto_theme/volto_locale` 时，桌面端仍能连接，但不会得到新的红绿灯布局，主题/语言回退到 cookie/系统。
- 红绿灯布局是 macOS 专用（`TitleBarStyle::Overlay`）；Windows/Linux 保留原生标题栏。
- 主题/语言保存在 `gateway-profiles.json`（与档案同一文件），不写网关的 cookie；每次进入网关都由 `?volto_*` 查询参数覆盖，因此换网关也一致。
- 打包产物不内嵌 gateway/web；本机托管需要 Node 与仓库里的 gateway 构建（或用 `VOLTO_GATEWAY_BIN` 指向已安装包）。
- 探测依赖 curl 子进程；每请求有 4 秒超时。
- 单实例用配置目录的 `instance.lock`（PID + 存活检查）；第二个实例直接退出，不会聚焦第一个窗口。
- 令牌明文存于 `~/.config/.../gateway-profiles.json`（0600），与 gateway 自己的 `access-token` 同信任级；后续可换系统钥匙串。