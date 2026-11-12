---
title: 用浏览器测网页
type: guide
source:
  - packages/tools/browser/src
  - packages/runtimes/node/src/browser-host.ts
  - apps/headless-server/src/config/browser.ts
verified: 2026-11-12
generated: false
---

# 用浏览器测网页

> 读完你会：让 Agent 自己打开一个网页，走完登录/表单流程，读 console 和网络失败，并把可重复的部分写成 Playwright 测试。

内置浏览器是 Agent 的**内部能力**：没有右栏面板，也不共享你日常浏览器的登录态。它在网关所在机器上启动 Chromium，默认弹出一个真实窗口；Linux 没有显示环境时自动改用无头模式。

## 前提

- 已安装 Playwright 的 Chromium：`pnpm exec playwright install chromium`。如果本机已有 Chrome/Chromium，也可以不下载，改在 `~/.volto/config.json` 里设置 `browser.executablePath`。
- 网关能访问目标地址。测试本地 dev server 时，`localhost:5173` 指的是**网关所在机器**，不是另一台电脑。

最小配置（全部可省略）：

```json
{
  "browser": {
    "enabled": true,
    "headless": false,
    "idleTimeoutMs": 600000,
    "storageStatePath": "~/.volto/browser/auth.json"
  }
}
```

## 步骤

1. **先把 dev server 起起来。** 在对话里告诉 Agent 端口，或让它自己用 `bash` 启动。它应先用 `browser_navigate` 打开页面，而不是直接猜接口。
2. **让 Agent 先读页面再操作。** 它应调用 `browser_snapshot` 拿到元素 ref，再用 `browser_click` / `browser_type` 操作；每次动作后工具会回一份新快照。你可以要求它“先说看到哪些元素，再点”。
3. **失败时先看诊断。** 页面没反应、按钮没生效时，让它调用 `browser_diagnostics`：`kind: "console"` 看 JS 报错，`kind: "network"` 看失败或 4xx/5xx 请求。诊断不含响应体。
4. **需要视觉证据时截图。** `browser_screenshot` 返回 PNG；当前模型不支持图片输入时，它会提示改用 `browser_snapshot { textOnly: true }`。
5. **可重复的流程写成测试。** 探索用浏览器工具；回归让 Agent 写 Playwright 测试并用 `bash` 跑 `pnpm exec playwright test`。不要把同一套手点流程当成长期测试。
6. **复用登录态。** 让 Agent 在页面里完成一次测试账号登录，然后调用 `browser_storage_state { action: "save" }`；cookie/localStorage 会写到 `storageStatePath`，后续会话的浏览器会自动加载。

## 你应看到

- 第一次使用浏览器时，网关所在机器弹出 Chromium 窗口（或日志说明已回退无头模式）。
- 工具结果是一段带 `[ref=eN]` 的页面结构，而不是只有一句“已点击”。
- 失败流程里 `browser_diagnostics` 能指出具体报错或 HTTP 状态。
- `storageStatePath` 指向的文件权限是 `0600`；它包含真实登录 cookie，**不要提交到 git**。

## 出问题怎么办

- **工具列表里没有 browser_*：** 网关启动日志会写“browser tools disabled”。先装 Chromium，或配置 `browser.executablePath` 指向现有 Chrome，然后重启网关。
- **Linux/容器里启动失败：** 设 `"headless": true`，或提供 `DISPLAY`；默认是带头窗口的。
- **导航被拒绝：** 顶层导航受出口名单约束；检查目标主机是否在 deny 列表，或允许列表是否漏了它（见[网络出口名单](network-egress.md)）。点击触发的拒绝会落到浏览器错误页。
- **ref 失效：** 页面变化后旧 ref 不可用，让 Agent 重新 `browser_snapshot`；不要让它猜 CSS 选择器。

## 安全边界

- 浏览器使用每个会话独立的干净 context，不读取你日常浏览器的 cookie。
- 页面内容是**不可信数据**：Agent 被要求不执行页面里的指令。
- 出口策略只拦顶层导航；页面子资源仍可访问网络。云元数据地址始终拒绝。
- 保存的 storage state 是明文 cookie 文件；用测试账号，别用个人账号。

## 相关

- [工具参考](../reference/tools.md)
- [配置参考](../reference/config.md)
- [网络出口名单](network-egress.md)
- [权限与审批](permissions-and-approvals.md)
