# Volto Desktop

> Volto agent 的 Electron 桌面客户端 —— 提供可视化对话、调试、权限审批与配置面板。

基于 `@voltojs/sdk` 构建，主进程承载 agent 内核与工具栈（FS / Shell / Network / OpenAI Provider），渲染进程通过 IPC 与之通信。所有可观测事件均经统一的 EventSink 桥接到渲染端，用于实时聊天与调试视图。调试面板（🐛）含事件时间轴、工具追踪、State 检视、**时间旅行**（checkpoint 列表 + 回退 diff）与日志五个 Tab。

## 项目布局

```
apps/desktop-app/
├── electron.vite.config.ts    # electron-vite 三进程构建配置
├── electron-builder.yml       # 打包配置（mac / win / linux）
├── resources/                 # 图标 SVG 源与生成说明（不含二进制）
├── src/
│   ├── main/                  # 主进程
│   │   ├── index.ts           # 入口 + 应用生命周期
│   │   ├── window.ts          # BrowserWindow 创建
│   │   ├── agent/             # ApprovalGate、AgentManager、wiring、EventBridge
│   │   ├── ipc/               # store / agent IPC handler
│   │   └── store/             # electron-store + Schema
│   ├── preload/               # contextBridge 暴露 electronAPI
│   └── renderer/              # React UI
│       └── src/
│           ├── App.tsx
│           ├── components/    # chat / approval / debug / settings / layout / ui
│           ├── hooks/         # use-agent / use-stream / use-approval / use-debug / use-store
│           ├── stores/        # chat-store / debug-store（瞬态）
│           └── types/         # electron / agent 类型契约
└── tsconfig.{json,node,web}.json
```

## 安装

需要 Node ≥ 20 与 pnpm ≥ 9。

```bash
# 从 monorepo 根（不要单独在本目录跑 install）
pnpm install
```

> 本应用是 turbo monorepo 的一员，依赖 `@voltojs/sdk`（workspace）。从根目录运行 pnpm 才会正确解析 workspace 链接。

## 开发

```bash
# 启动开发模式（含 React 热重载）
pnpm --filter @voltojs/desktop-app dev

# 仅做 type / lint 检查
pnpm turbo run typecheck lint --filter @voltojs/desktop-app
```

启动后会弹出 Electron 窗口。首次使用前请打开右上 ⚙ 设置弹窗，在「模型」Tab 中**新增供应商**（填写 OpenAI 兼容服务的 API Key，可选自定义 baseURL）并为其添加至少一个模型；然后在对话页左上角选择该模型即可开始。

## 配置

所有配置项保存在 electron-store（路径 `userData/volto-config.json`），由 Sidebar 右上的 ⚙ 按钮（设置）和 🐛 按钮（调试面板）入口管理。

| 字段 | 含义 | 入口 |
|---|---|---|
| `providers` | 供应商列表，每项含 `name` / `baseURL` / `apiKey` / `models[]`（模型为 `{name, code, contextLength?}`） | 设置 → 模型 |
| `permissionMode` | 权限策略 `auto` / `ask` / `deny` | 设置 → 权限 |
| `sessions` / `sessionMessages` | 会话历史；每个会话绑定 `providerId` / `modelId` | 由 Sidebar 自动写入 |

变更字段会**立即写盘**。模型选择是**会话级**的：对话页左上角切换模型后，该会话的 agent 实例立即重建生效，无需全局重建按钮。

### 权限模式语义

| store 值 | 映射 | 行为 |
|---|---|---|
| `auto` | `permissionConfig.mode = "auto-accept"` | 全部工具调用直接放行 |
| `ask`（默认） | `mode = default`，`IRREVERSIBLE: "ask"` | 高风险写入与不可逆操作弹出审批对话框 |
| `deny` | `mode = default`，全 tier `"deny"` | 全部工具调用直接拒绝（只读模式） |

> ⚠️ 历史注意：`@voltojs/core` 的 `mode = "plan"` 是"只读模式"而非"询问模式"——把 store 的 `"ask"` 错映射到 `"plan"` 会让 ApprovalDialog 永远不弹。详见 `src/main/agent/wiring.ts` 头部长注释。

## 打包

四个目标对应四个 npm 脚本：

```bash
# 验证打包配置（仅解包到 dist/，不出 installer，不签名）—— CI / 本地烟测
pnpm --filter @voltojs/desktop-app package:dir

# 各平台 installer（需要对应平台原生工具链）
pnpm --filter @voltojs/desktop-app package:mac     # .dmg + .zip
pnpm --filter @voltojs/desktop-app package:win     # .nsis
pnpm --filter @voltojs/desktop-app package:linux   # .AppImage + .deb
```

### 图标资源

打包时 electron-builder 会从 `resources/icon.{icns,ico,png}` 读取对应平台图标。仓库**不提交**二进制图标，只放 SVG 源：见 `resources/README.md` 自行生成。

缺图标时 electron-builder 会告警并使用 electron 默认图标——可以正常完成 `--dir` 打包验证，但发布前请生成自己的图标。

### 代码签名 / 公证 / 自动更新（暂未配置）

以下能力本应用范围内**不**默认启用，由发布工作流补充：

- macOS 签名：填入 Apple Developer ID（`CSC_LINK` / `CSC_KEY_PASSWORD` 环境变量），在 `electron-builder.yml` 取消注释 `hardenedRuntime` / `notarize`
- Windows 签名：配置 Code Signing 证书
- 自动更新：在 yml 末尾 `publish` 段填入 GitHub / S3 等 provider，应用主进程接入 `electron-updater`
- 上架 Mac App Store / Microsoft Store：需要 sandbox 配置 + 单独的 entitlements

## 故障排查

| 现象 | 排查 |
|---|---|
| 启动后窗口空白 | 检查 `userData/volto-config.json` 是否损坏，必要时删除该文件重置 |
| Agent 不响应 / "API Key not configured" | 在 ⚙ 设置 → 模型 中新增供应商并填入有效 API Key；确认对话页左上角已为该会话选择模型 |
| 工具调用永远 deny / 没弹审批 | 权限模式可能是 `deny`，切到 `ask` 或 `auto` |
| 流式消息不显示 | 打开 🐛 调试面板的"事件时间轴"看 `text_delta` 是否到达；不到达说明主进程 EventSink 桥接异常 |
| 重启后会话丢失 | 检查 electron-store 写入权限，DevTools 跑 `await window.electronAPI.store.get("sessions")` 验证 |

## 相关文档

- `../../docs/dev/architecture.md` — agent 内核架构
- `../../docs/superpowers/specs/` 与 `../../docs/superpowers/plans/` — 每个特性的设计与实施记录
- `../gateway/` — 同套 SDK 的 HTTP + SSE 网关宿主
