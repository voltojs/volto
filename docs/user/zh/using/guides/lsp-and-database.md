---
title: 代码智能与数据库
type: guide
source:
  - apps/gateway/src/config/lsp.ts
  - packages/runtimes/node/src/lsp.ts
  - packages/runtimes/node/src/database.ts
  - apps/gateway/src/wiring.ts
generated: false
verified: 2026-11-11
---

# 代码智能与数据库

> 读完你会：让 agent 用上语言服务器查定义/引用，以及安全地查 SQLite。

## 代码智能（LSP）

网关为每个会话装配语言服务器，暴露五个工具：

| 工具 | 作用 |
| --- | --- |
| `lsp_definition` | 跳到符号定义 |
| `lsp_references` | 找符号被引用的所有位置 |
| `lsp_hover` | 看类型签名与文档 |
| `lsp_rename` | 预览重命名会改哪些地方（不落盘） |
| `lsp_diagnostics` | 取类型/语法错误 |

**内置只覆盖 TypeScript / JavaScript。** 其它语言在 `~/.volto/config.json` 的 `lsp` 分区登记：

```json
{
  "lsp": {
    "servers": {
      "python": { "command": "pyright-langserver", "args": ["--stdio"] }
    }
  }
}
```

每个语言服务器需要 `command`、`args`，可选 `initializationParams`。配置非法会拒绝启动；某种语言没配置时，调用会返回一段**可直接复制**的配置片段，而不是让整个会话构不出来。

### 几个实际会遇到的限制

- **没装 `typescript-language-server` 时五个工具仍然可见**，调用返回 `LSP_SERVER_MISSING` 与安装命令（`npm install -g typescript-language-server typescript`）。工具不会静默消失，因为「消失」比「报错」更难排查。
- **在途请求不可取消。** 单次请求默认最长等 15 秒；超时会回收连接（杀掉子进程），下一次调用重新起一个，因此一次超时不会永久污染后续调用。
- **只读档下语言服务器写不了自己的缓存**，超大仓会明显变慢。这是隔离的代价。
- **语言服务器子进程受会话沙箱约束、默认封网**，凭据目录 `~/.volto` 不可读。

## 数据库（SQLite）

两个工具：`db_query`（只读）与 `db_exec`（写）。写工具**只在宿主授予写权限时存在**——只读与计划档下它根本不注册，模型看不到它，而不是「看得见但必然被拒」。

三层约束，缺一不可：

1. **路径必须在工作区内**：库文件路径经 realpath 校验，越界直接拒绝（fail-closed）。
2. **查询用只读句柄**：`readonly` + `PRAGMA query_only = ON`，写语句由 SQLite 引擎拒绝，不靠正则预筛。
3. **显式拒绝危险语句**：`ATTACH` / `DETACH` / `VACUUM INTO` / `load_extension` 一律拒绝——这几条只读句柄拦不住，却都能绕开工作区去打开任意文件。

## 出问题怎么办

- **`lsp_*` 全报 `LSP_SERVER_MISSING`** → 装 `typescript-language-server`；非 TS/JS 语言要先在 `lsp` 分区登记。
- **诊断结果很旧** → 只读档下语言服务器无法写索引缓存；换可写档或等它重建。
- **`db_query` 报「库不在工作区内」** → 把库放进工作区，或用绝对路径确认它在工作区内。
- **`db_exec` 找不到** → 当前会话是只读或计划档；换到可写档新建会话。
- **打开库报原生模块缺失** → 宿主未安装 `better-sqlite3`，按返回的安装命令装。这是宿主依赖，不是 agent 能力缺失。