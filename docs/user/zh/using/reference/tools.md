---
title: 工具参考
type: reference
generated: true
source:
  - packages/tools/*/src
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand. Run `pnpm docs:gen`; hand edits are reported as drift by `pnpm docs:check`. -->

# 工具参考

agent 能调用的每一个工具。**工具可见不等于被放行**——三档权限与审批卡见 [权限与审批](../guides/permissions-and-approvals.md)。

| 工具 | 分组 | 用途 |
| --- | --- | --- |
| apply_patch | fs | 按 unified diff 打补丁；要求先 read_file 过同一个文件。 |
| ask_user | ask | 向用户提问并等回答——用于需求含糊、需要人做选择时。 |
| bash | shell | 执行 shell 命令，默认走持久会话（cd、环境变量在轮次之间保留）。 |
| bash_output | shell | 读取后台命令的增量输出，不必等它跑完。 |
| browser_click | browser | 按快照里的 ref 点击元素；ref 失效时让 Agent 重新 snapshot。 |
| browser_diagnostics | browser | 看最近的 console/page 错误和失败/4xx/5xx 请求，不含响应体。 |
| browser_navigate | browser | 让 Agent 打开 http(s) 页面，或前进/后退/刷新，返回带 ref 的页面快照。 |
| browser_press_key | browser | 在页面或焦点元素上按键（Enter、Escape、Tab、方向键等）。 |
| browser_screenshot | browser | 截当前页面为 PNG；截图会作为工具结果显示在轨迹中，可点缩略图全屏查看、缩放、拖动和下载。需要附件存储和图像模型。 |
| browser_snapshot | browser | 读当前页面结构，拿到可点击/可输入的 ref；优先用它定位元素。 |
| browser_storage_state | browser | 把当前登录态（cookie/localStorage）保存到配置的路径，供后续会话复用。 |
| browser_type | browser | 按 ref 填写输入框，可顺便回车提交。 |
| browser_wait_for | browser | 等某段文字出现或等一段时间，再回一份新快照。 |
| build | vcs | 在给定的构建命令下执行一次构建，返回成功/失败与错误摘要（命令由调用方传入）。 |
| cancel_task | schedule | 取消一个已排定的定时任务。 |
| db_exec | data | 执行写 SQL；只有宿主授予写权限时才出现。 |
| db_query | data | 执行只读 SQL 查询。 |
| edit_file | fs | 按 old/new 文本替换修改文件；精确匹配失败时有容错匹配。 |
| git_commit | vcs | 把当前改动提交为一个 commit。 |
| git_diff | vcs | 看工作区或某个提交范围的 diff。 |
| git_push | vcs | 把当前分支推到远端。 |
| git_status | vcs | 看哪些文件改了、怎么改的（结构化状态码）。 |
| glob | fs | 按文件名模式找文件，按修改时间排序。 |
| grep | fs | 按正则搜文件内容，可限定目录与文件类型。 |
| http_query | data | 发一个自定义 HTTP 请求（方法、头、请求体都可指定）。 |
| kill_shell | shell | 结束一个后台命令。 |
| list_watches | fs | 列出当前已注册的文件监听。 |
| ls | fs | 列目录内容。 |
| lsp_definition | code | 跳到某个符号的定义位置。 |
| lsp_diagnostics | code | 取语言服务器报的类型 / 语法错误。 |
| lsp_hover | code | 看某个符号的类型签名与文档。 |
| lsp_references | code | 找出某个符号被引用的所有位置。 |
| lsp_rename | code | 预览重命名会改哪些地方（不落盘）。 |
| memory | memory | 读写跨会话的长期记忆：按关键词检索、写入一条记忆。 |
| multi_edit | fs | 对同一个文件做多处替换，要么全成要么全不改。 |
| read_document | document | 读 PDF / DOCX / XLSX / 图片并转成文本。 |
| read_file | fs | 读文件（带行号）；也能读图片与 PDF 页面。 |
| run_tests | vcs | 在给定的测试命令下执行，解析常见测试输出并列出失败的用例名（命令由调用方传入）。 |
| schedule_task | schedule | 安排一个延时任务，到点后唤醒会话。 |
| skill | skill | 加载某个技能包的完整说明。 |
| task | agent | 派一个子代理去干一件独立的子任务；写了验收标准就会在完成后判定，不达标默认自动返工一次。 |
| task_output | agent | 取子代理任务的结果。 |
| todo_write | plan | 维护当前任务的待办清单，让进度对人和模型都可见。 |
| unwatch_files | fs | 停止一个文件监听。 |
| watch_files | fs | 监听文件或目录的变化。 |
| web_fetch | web | 抓取一个网页的正文。 |
| web_search | web | 联网搜索。 |
| write_file | fs | 新建或整体覆盖一个文件；覆盖已存在的文件要求先 read_file。 |

共 48 个。分组对应 `packages/tools/<分组>`；同一分组的工具共享一组权限能力。

> 这张表由 `pnpm docs:gen` 生成：中文用途来自 `docs/user/reference/tool-notes.json`，新增工具缺条目会让 `pnpm docs:check` 失败。
