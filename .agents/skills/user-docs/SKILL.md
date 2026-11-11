---
name: user-docs
description: 修改 volto 的用户文档（docs/user/）时使用——写新页、补生成页的 notes、判断某次代码改动是否要让用户文档跟进，以及跑 docs:check 门。触发于"更新用户文档""写使用说明""这个改动要不要改文档""docs:check 失败"。
---

# 用户文档（docs/user）

规则全文在 `docs/user/WRITING.md`，**先读它**。这里只放不能忘的判据和命令。

## 两条轨

- `using/` — 装好就用的人。写界面上的词、命令、配置字段。
- `integrating/` — 用 `@volto/sdk` 嵌宿主的人。写端口、选项、事件。
- `concepts/` — 两者共享，讲概念不讲操作。

在 `using/` 里出现 reducer / port / Effect / capability 就是写错轨了。

## 改代码时的判定

这次改动是否影响**使用者**看得见 / 配得了 / 能感知的东西（界面文案、菜单、配置键、默认值、错误信息、权限语义、工具可见性、安装步骤），或**集成者**依赖的公开面（`@volto/sdk` 导出、`createAgent` 选项、端口契约、事件类型、网关路由）？

命中 → 同一提交内更新 `docs/user/`。没命中 → 不用动。

## 生成页

`using/reference/tools.md`、`using/reference/config.md`、`integrating/reference/gateway-api.md`、`integrating/reference/sdk-exports.md` 是生成物。**不要手改**：

- 工具说明 → `docs/user/reference/tool-notes.json`
- 配置字段 → `docs/user/reference/config-sections.json`
- 网关接口 → `docs/user/reference/gateway-notes.json`
- SDK 导出 → 改 `packages/sdk/src/index.ts`

改完 `pnpm docs:sync`。

## 命令

```bash
pnpm turbo run build   # docs:check 的示例编译需要 dist
pnpm docs:check    # 只读检查（CI 跑它）
pnpm docs:sync     # 重新生成 + 接受当前表面基线
pnpm docs:ack "理由"  # 表面变了但确认无需改文档
```

## 失败怎么读

- `生成页与输入不一致` → `pnpm docs:sync`；若是手改，先撤销手改。
- `工具 X 缺少中文说明` → 补 `tool-notes.json`，一句话说清「什么时候用」。
- `用户可见表面发生了变化` → 它已经列出受影响页面，改完 `pnpm docs:sync`；确认无感才 `docs:ack`。
- `示例代码编译失败` → 示例必须能过 `tsc`，别写伪代码。
- `孤儿页` → 在 `docs/user/README.md` 里加入口。

## 不要做

- 不把 spec / plan 的内容搬进来。
- 不建「待补充」占位页。
- 不复制 `using/` 与 `integrating/` 的同一段内容——一处解释，另一处链接。