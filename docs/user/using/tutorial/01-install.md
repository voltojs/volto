---
title: 安装并启动
type: tutorial
source:
  - apps/headless-server/src/server.ts
  - apps/headless-server/src/auth/browser-auth.ts
  - apps/web/package.json
generated: false
verified: 2026-11-11
---

# 安装并启动

> 读完你会：在本机跑起网关与 Web 界面，并用浏览器登录进去。

## 前提

- **Node.js ≥ 22**（`node -v` 确认）
- pnpm 10
- macOS 或 Linux。Windows 没有沙箱后端，只能用「完全」权限档，见 [沙箱与平台](../guides/sandbox-and-platforms.md)

## 步骤

### 1. 安装依赖并构建

```bash
pnpm install
pnpm turbo run build
```

首次构建约 1–2 分钟。**不能跳过**：网关的入口是构建产物 `dist/server.js`。

你应看到：命令结束，没有红色报错。

### 2. 启动网关（终端 1）

```bash
cd apps/headless-server
pnpm start
```

你应看到两行地址：

```text
Headless server listening on http://localhost:3100
Open this URL to authenticate: http://localhost:3100/auth?token=…
```

### 3. 启动 Web 界面（终端 2）

```bash
cd apps/web
pnpm dev
```

你应看到 `ready` 与 `http://localhost:6100`。

### 4. 登录

用网关打印的 **`Or open the web app URL:`** 那一行（形如 `http://localhost:6100/gateway?token=…`）打开浏览器。它会把一次性 token 换成 cookie，落在 Web 界面自己的域上。

> token 只在网关启动时生成一次。网关重启后旧链接失效，用新打印的链接即可。

你应看到：聊天界面，左侧会话列表为空，输入框在窗口底部。

## 出问题怎么办

- **`pnpm start` 报找不到 `dist/server.js`** → 漏了第 1 步的构建。
- **端口被占用** → 3100（网关）或 6100（前端）已有进程，先停掉旧的再启动。
- **页面打开 401 / 一直跳登录** → 用错了地址：要开带 `token=` 的那个 URL，不是 `http://localhost:3100`。

## 下一步

[配置模型，开始第一次对话](./02-first-conversation.md)