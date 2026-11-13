---
title: 工具契约
type: reference
source:
  - packages/core/src/tool.ts
  - packages/sdk/src/tool-scope-default.ts
  - packages/tools/src/common
generated: false
verified: 2026-11-11
---

# 工具契约

> 读完你会：会写一个能被内核正确调度的工具，并知道它什么时候会被藏起来。

## 声明一个工具

```ts
const definition = {
  name: "read_file",
  description: "读文件，带行号。",           // 模型靠这句话决定用不用
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],             // 能力：没有这个能力就不对模型可见
  riskTier: "READ_ONLY",                    // 权限策略按它分档
  pathInputs: ["path"],                     // 路径入参：让 pathPattern 规则能匹配
  hostInputs: [],                           // URL 入参：让 hostPattern 规则能匹配
  commandInputs: [],                        // 命令入参：让 commandPrefix 规则能匹配
} as const;
```

四个字段决定它是否被看见、是否被放行：

| 字段 | 影响 |
| --- | --- |
| `requires` | **可见性**：缺能力 → 不进入模型可见集 |
| `riskTier` | **放行**：`READ_ONLY` / `WRITE_LOW` / `WRITE_HIGH` / `IRREVERSIBLE` |
| `pathInputs` / `hostInputs` / `commandInputs` | **规则匹配**：不声明，对应规则永远命中不了 |
| `trust` | 输出是否被当作不可信内容标注（注入防护） |

「可见性」和「放行」是两件事，别混：

- 可见性由装配决定（有没有对应端口、能力够不够、工具预算够不够）。
- 放行由权限决定（`allow` / `deny` / `ask`）。
- 一个工具可以先可见、再被拒；它不会因为「可能会被拒」而从可见集里消失。

## 结果的双层结构

```ts
function finish(diff: string, ms: number) {
  return {
    modelContent: "……",              // 给模型：精简；超量必须截断并在文本里声明
    displayMetadata: { diff, ms },    // 给界面：完整内容、耗时、行数
    isError: true,                    // 失败也是结果，不是异常
  };
}
```

- `modelContent` 会进上下文，是付费的；宁可截断 + 一句「已截断」也不要灌满。
- `displayMetadata` 只走事件流，不进上下文，可以放大对象。

## 工具预算

同一时刻对模型可见的工具默认上限是 **20 个**（装配了记忆时 21）。超出的按分档优先级竞争，未命中分档的工具落到最后。

这意味着：**你自己加的工具会和内置工具抢位置**。大量小工具不如一个带参数的组合工具。

## 写工具的 checklist

- [ ] `name` 是 snake_case，且在全局唯一
- [ ] `description` 说清「什么时候用」，不只是「做什么」
- [ ] `inputSchema` 里每个字段有描述——模型照着它填
- [ ] 声明了 `requires`，缺失时能被正确藏起来
- [ ] 声明了 `pathInputs` / `hostInputs` / `commandInputs`（有的话），否则权限规则对它无效
- [ ] 失败返回 `isError: true`，不要 `throw`
- [ ] 大输出截断并声明截断

## 出问题怎么办

- **工具不出现**：检查 `requires` 的能力是否有人授予，以及是否超出了工具预算。
- **规则匹配不上**：多半是没声明对应的入参字段。
- **模型反复调用同一个工具**：`description` 里没说清何时停止，或返回值里没给「已经做完了」的信号。