# 写用户文档的规矩

这份文件是给**人和 agent 共读**的：人和模型写出来的页面应该看不出区别。开发文档（`docs/superpowers/`）的规则不适用这里——那边写「为什么这样设计」，这边只写「怎么用」。

## 两条轨，别串台

| 目录 | 读者 | 回答的问题 | 允许出现的词 |
| --- | --- | --- | --- |
| `using/` | 用这个 agent 的人 | 我怎么让它做某件事？ | 界面上的词、命令、配置字段 |
| `integrating/` | 把 agent 嵌进自己宿主的人 | 我怎么把它接起来？ | 端口、类型、选项、事件 |
| `concepts/` | 两者 | 它为什么这样表现？ | 概念名，但首次出现要有一句人话解释 |

判据：**一个页面里出现「reducer」「port」「Effect」这类词，而读者是 `using/` 的人，就是写错了地方。**

## 页面骨架

```markdown
---
title: 权限与审批
type: guide
source:
  - apps/headless-server/src/config/permissions.ts
generated: false
verified: 2026-11-11
---

# 权限与审批

> 读完你会：<一个可验证的结果>

## 前提            ← 可选
## 步骤            ← 编号；每步写「你应看到」
## 出问题怎么办     ← 最多 3 条，指向 troubleshooting
## 相关
```

- `title` 与 H1 一致。全文**只有一个 H1**。
- `type` 四选一：`tutorial`（带着做一遍）· `guide`（解决一个问题）· `reference`（查表）· `concept`（讲清一个概念）。
- `source` 写这页描述的实现路径，支持 `*` 通配。**它的用途不是给人看的，是给漂移检测用的**：改到这些文件时，这页大概率要一起改。
- `verified` 是你（人或 agent）**对照实际界面与行为**核对过的日期，不是「改过」的日期。
- 单页 ≤ 350 行。超了就是该拆页。

## 写作规则

1. **先给结果，再给步骤。** 开头一句「读完你会…」，读者据此决定要不要读下去。
2. **每步都要有「你应看到」。** 没有可观察结果的步骤，读者无法自查。
3. **命令块必须能直接复制**，不要用 `…` 省略关键参数。
4. **只留结论，不留论证。** 边界为什么这样，写在 `SAFETY.md`；这里只写「它挡什么、不挡什么」。
5. **不复制。** 同一机制只在一处解释，别处链接过去。`using/` 与 `integrating/` 之间复制内容会被检查提示。
6. **术语固定**：工作区 / 会话 / 子代理 / 审批 / 沙箱 / 供应商 / 技能 / 记忆 / 宿主 / 端口。
7. **截图**放 `assets/`，命名 `<页面名>-<步骤>.png`，用相对路径引用（链接检查会校验文件存在）。

## 生成的页面

这四个文件由脚本生成，**手改会被检查判为漂移**：

| 文件 | 输入 |
| --- | --- |
| `using/reference/tools.md` | 各工具包里的工具声明 + `reference/tool-notes.json` |
| `using/reference/config.md` | `config.json` 分区 + `reference/config-sections.json` |
| `integrating/reference/gateway-api.md` | 网关路由 + `reference/gateway-notes.json` |
| `integrating/reference/sdk-exports.md` | SDK 的导出语句 |

要改内容：改代码，或改对应 notes JSON，然后 `pnpm docs:sync`。

**notes 的缺口是硬错误**：新增一个工具却没写中文说明，`docs:check` 直接失败。这条是故意的——没有它，生成器只会产出一堆英文 description，看起来有文档、实际没法读。

## 检查与提交

```bash
pnpm docs:check    # 只读检查，CI 跑的就是它
pnpm docs:sync     # 重新生成参考页 + 接受当前表面基线
pnpm docs:ack "理由"  # 表面变了但确认无需改文档时用；理由会进 diff
```

`docs:check` 会拦住这些：

- 生成页与输入不一致（手改过，或代码改了没重新生成）
- 链接 / 锚点 / 图片指向不存在的目标
- 工具、配置字段、网关路由新增或删除后 notes 没跟上
- **用户可见表面变了，但基线没同步**（见下）
- 集成者文档里的 TypeScript 示例编译不过
- 孤儿页（没有任何页面链接到它）

## 表面基线是什么

`docs/user/.meta/surface.json` 记录了几组「用户能感知的东西」的指纹：工具清单、网关路由、配置分区与字段、SDK 导出、SDK 类型签名、界面文案目录。

改代码导致指纹变化时，`docs:check` 会失败，并**点名该看哪几页**（映射在 `.meta/routing.json`）。两条出路：

1. 改了相关页面 → `pnpm docs:sync` 更新基线；
2. 确认这次改动对用户无感 → `pnpm docs:ack "理由"`。

两者都会在提交里留下痕迹，评审时看得见。**`docs:ack` 不是免检通行证**：ack 频率过高说明指纹的粒度太粗，该讨论的是收紧检查，而不是继续 ack。

## 新增一个页面的流程

1. 确认现有页面里没有它该待的位置（宁可加一节，不要加一页）。
2. 建文件，写 front-matter，`source` 指到实现。
3. 在 `README.md` 的对应轨道里加入口（否则孤儿页检查会失败）。
4. `pnpm docs:check`。

## 不要做的事

- 不要把 spec / plan 的内容搬过来。读者不需要知道当时为什么选了这个方案。
- 不要写「TODO」「待补充」占位页。没有内容就不建页。
- 不要用「显然」「简单地」这类词——读者卡住时它们只会让人更烦躁。
- 不要在 `using/` 里贴几十行的配置 JSON 全文，给最小可用的片段 + 指向 `reference/config.md`。