---
title: 工具装配与权限策略
type: guide
source:
  - packages/core/src/tool-router.ts
  - packages/core/src/permission-policy.ts
  - packages/sdk/src/tool-scope-default.ts
  - packages/core/src/permission-presets.ts
generated: false
verified: 2026-11-11
---

# 工具装配与权限策略

> 读完你会：能解释「为什么某个工具没出现」和「为什么某个调用被拒」是两套机制，并各自调对。

## 一次调用经过的环节

顺序固定，前四步决定「能不能发生」，后三步决定「发生了什么」：

```text
注册 → 能力门控 → 可见性裁剪 → 权限决策 → 审批 → 执行 → 结果归一化
```

| 关 | 决定 | 载体 |
| --- | --- | --- |
| 能力门控 | 这台宿主有没有实现它需要的能力 | `ToolDefinition.requires` × `capabilities` |
| 可见性裁剪 | 一次最多给模型看几个工具 | `ToolScopeConfig` + `limit` |
| 权限决策 | 这次调用 allow / deny / ask | `PermissionConfig`（`{ sandbox, approval }` + `rules`） |
| 审批 | 需要问的时候问谁 | `ApprovalGate.ask(call, riskTier)` |

前两关失败的表现是「模型根本不知道有这个工具」，后两关失败的表现是「模型知道自己被拒了」。混在一起会让排查方向完全错——详见 [可见性与放行](../../concepts/tools-and-permissions.md)。

## 可见性裁剪

默认由 SDK 按装配情况推导，分组与优先级是：文件/命令/git（100）· 会话基础（50）· 记忆（45）· 模式组 lsp / db / browser（40）· 信息类（20）· 其余（0）。总量上限 20，装配了记忆时 21。

自己覆盖时形状是：

```ts
const scope = {
  groups: {
    fs: { priority: 100 },
    shell: { priority: 100 },
    browser: { priority: 40, enabled: false },
  },
  toolGroups: { mcp__srv__echo: "mcp" },
};
```

- 只有**启用分组**里的工具会被保留；没归组的工具在显式指定 `groups` 时会被排除。
- 分组名默认取 `__` 之前的第一段（`mcp__srv__echo` → `mcp`）；名字里没有 `__` 的工具用**全名**做分组（`lsp_definition` → `lsp_definition`）。SDK 的默认装配用显式 `toolGroups` 把这些名字归进五档。
- 超出上限时按优先级竞争，**同优先级保持原顺序**（稳定裁剪，不会每轮抖动）。

想让某组工具消失，用 `enabled: false`；想彻底不给模型看，收掉它 `requires` 的能力更彻底。

## 权限决策

`PermissionConfig` 是二元组加规则：

```ts
const permission = { sandbox: "workspace-write", approval: "ask" };
```

- **规则优先于二元组**：`rules` 按顺序匹配，第一条命中生效。
- `sandbox` 是能力边界（只读 / 可写工作区 / 不隔离），`approval` 是打断策略（`never` / `ask`）。
- 规则只能**收紧**：只读边界下再多 `allow` 也不会放行写入。

规则匹配的输入由工具自己声明：`pathInputs`（路径，先解析成绝对真实路径）、`hostInputs`（URL 主机名）、`commandInputs`（命令文本）。**没声明的工具永远匹配不到对应规则**——这是最容易踩的坑。

## 审批

需要 `ask` 时，宿主实现：

```text
interface ApprovalGate {
  ask(call: PendingToolCall, riskTier: RiskTier): Promise<"allow" | "deny" | ApprovalResult>;
}
```

- 返回值可以是裸 `"allow"` / `"deny"`，也可以带原因（`ApprovalResult`）；原因进 `approval_decision` 转录事件与界面，不写进审计流水的字段里。
- 超时或宿主异常时应**拒绝**（fail-closed），而不是放行。
- 审批拒绝与权限拒绝走同一条路径：都变成 `isError: true` 的工具结果回喂模型，模型会换做法。

## 子代理的权限收窄

派发子代理时传 `permission` 预设，只能等于或窄于父会话。更宽的档位会被拒绝，并回给你可用档位列表。实现上是比较沙箱边界的名次，而不是字符串相等。

## 结果归一化

工具执行抛错、超时、端口异常，全部归一化成 `{ isError: true, modelContent: "…" }` 回给模型，**绝不中断主循环**。宿主不需要给每个工具包 try/catch：包住一层就等于包住并发模型调用，反而会吞掉真正的循环故障。

## 出问题怎么办

- **工具没出现** → 查 `requires` 对应的能力是否授予、分组是否被禁用、是否被 20 个上限挤掉。
- **规则写了不生效** → 查工具有没有声明对应的入参；`bash` 不声明路径入参，`pathPattern` 对它无效。
- **模型反复撞同一堵墙** → 检查拒绝原因是否可读；一句「不允许写 `.env`」比一个空错误有效得多。