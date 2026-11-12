---
title: 远程访问
type: guide
source:
  - apps/gateway/src/cli.ts
  - apps/gateway/src/auth/access-token.ts
  - apps/gateway/src/auth/middleware.ts
  - apps/gateway/src/client-ip.ts
  - apps/gateway/src/capabilities.ts
  - apps/gateway/src/web-server.ts
generated: false
verified: 2026-11-12
---

# 远程访问

> 读完你会：从手机或另一台电脑连上跑在自己机器上的 volto，并且清楚这一步把什么交了出去。

## 先读这段

**能访问到网关的人，等于能在这台机器上跑命令。** 网关的另一端是一个能读写文件、执行 shell 的 agent，它没有「只给我看看」的模式。所以：

- 尽量跑在一台**专用、或者可以整台丢弃**的机器上。
- 那台机器上**不要放你不愿意交给任何能打开那个网址的人的凭据**：SSH 私钥、云账号、生产数据库口令、浏览器登录态。
- 用别人猜不到的地址（隧道发给你的随机子域，图的就是这个）。

## 选一种做法

| 做法 | 适合 | 要多开进程吗 | 多一条命令吗 |
| --- | --- | --- | --- |
| **隧道**（推荐） | 手机、外网、跨网络 | 不用 | 要：另开一个隧道进程 |
| 局域网直连 | 同一 Wi-Fi、信任这个网络 | 不用 | 不用 |
| SSH 端口转发 | 网关在远程机器上，你只在本机用浏览器 | 不用 | 要：在你自己电脑上转发 |

共同前提：机器上先按 [安装并启动](../tutorial/01-install.md) 跑起网关，网关在自己的终端里跑着。

### 1. 隧道（推荐）

网关保持默认的 `127.0.0.1` 监听，由隧道进程把它转发出去。三选一。

**cloudflared**（免费、不用账号就能拿到一个临时随机域名）：

```bash
cloudflared tunnel --url http://127.0.0.1:3100
```

你应看到它打印一个 `https://<随机词>.trycloudflare.com` 的地址。用手机打开时**换成隧道域名、并带上 token**：

```text
https://<随机词>.trycloudflare.com/?token=<volto token>
```

token 怎么来见下文「换 token 与登录」。临时域名每次重启 `cloudflared` 都会变；要固定域名得用你自己的 Cloudflare 账号建命名隧道。

**tailscale serve**（设备本来就在你的 tailnet 里，最省事）：

```bash
tailscale serve --bg 3100
```

你应看到它报告一条 `https://<机器名>.<你的 tailnet>.ts.net` → `http://127.0.0.1:3100` 的转发。装了 Tailscale 且在同一 tailnet 的设备直接打开：

```text
https://<机器名>.<你的 tailnet>.ts.net/?token=<volto token>
```

`tailscale serve` 只对自己的 tailnet 开放，不经过公网。

**Caddy**（自己有服务器和域名的时候）：

```caddyfile
volto.example.com {
	reverse_proxy 127.0.0.1:3100
}
```

`caddy run` 之后打开 `https://volto.example.com/?token=<volto token>`。

隧道在网关前面终止 HTTPS，网关自己看到的是明文 HTTP。想让限流按真实客户端计数、cookie 带上 `Secure` 标记，加 `--trust-proxy`：

```bash
npx @volto/gateway --trust-proxy
```

只有**确定网关除了这层隧道之外无人可达**时才开：开启后网关会相信 `X-Forwarded-For` / `X-Forwarded-Proto`，而这两个头谁都能伪造（见下文）。

### 2. 局域网直连

同一网段、信任这台机器所在的网络时，可以让网关直接对外监听：

```bash
npx @volto/gateway --serve-remote --host 0.0.0.0
```

不加 `--serve-remote` 会直接拒绝启动：

```text
Refusing to bind to non-loopback host "0.0.0.0" without --serve-remote. The gateway exposes this machine's filesystem and an arbitrary-command agent.
```

然后从另一台设备打开 `http://<这台机器的局域网 IP>:3100/?token=<volto token>`。这条路上没有 HTTPS，cookie 不会带 `Secure`。

### 3. SSH 端口转发

网关在远程机器上、你只想在本机浏览器里用它时，**不要**开 `--serve-remote`，改成把端口转发过来：

```bash
ssh -N -L 3100:127.0.0.1:3100 you@dev-box
```

然后在本地打开 `http://127.0.0.1:3100/?token=<volto token>`（token 在远程机器上用 `volto token` 打印并抄过来）。网关自己仍然是 local 模式，原生对话框照常可用——只是它们会开在**远程机器**的屏幕上。

## `--serve-remote` 到底改了什么

它是一道显式开关，而不是根据监听地址猜出来的：

- **允许对外监听**：非 loopback 的 `--host` 没有它就直接拒绝启动，有它才放行。
- **进入远程模式**：`GET /gateway-info` 的 `mode` 变成 `remote`，启动时 stderr 多一行提示。
- **关掉原生对话框**：`POST /fs/pick-directory`（选目录）和 `POST /fs/reveal`（在文件管理器中显示）返回 501（这项能力在这台实例上不可用）。原因是这类窗口会弹在**网关那台机器**的屏幕上，替你点选的也会是坐在那台机器前的人。
- **它不加加密、也不建隧道**：「允许对外」是它做的全部；要上公网还得靠隧道或反向代理。

**远程模式下加工作区**：界面上的「添加工作区」走的是系统目录对话框，远程模式下必然失败。用接口注册一个绝对路径，刷新页面就能在下拉框里选到：

```bash
curl -X POST http://127.0.0.1:3100/projects \
  -H "Authorization: Bearer <volto token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","path":"/home/me/myrepo"}'
```

`path` 在**网关那台机器**上解析——写它上面的路径，不是你自己电脑上的路径。

## 换 token 与登录

网关认两种凭据：

| 凭据 | 从哪来 | 活多久 |
| --- | --- | --- |
| 启动 token | 每次启动打印的 `Open:` 链接里那串 | 进程活着期间；重启就换新的 |
| 持久 token | 存在 `~/.volto/access-token`，`~/.volto` 不是默认值时在 `--config-dir` 那个目录 | 一直不变，直到你轮换 |

远程场景用持久 token——重启网关不会让它失效：

```bash
npx @volto/gateway token
```

你应看到两行：token 本身，然后一条 `Open: http://<地址>/?token=<token>` 的登录链接。**把里面的地址换成你的隧道域名**再打开就能登录。

登录成功后 token 会被换成 cookie（7 天内有效），地址栏回到干净的 `/`。

怀疑 token 泄露了就换掉：

```bash
npx @volto/gateway token --rotate
```

它打印新 token，并且**立刻**让所有已经发出的 cookie 失效——网关还在跑，不用重启。已经登录的浏览器下一次调用接口就会被要求重新登录，用新链接重新进即可。

## `--trust-proxy` 与 `VOLTO_CORS_ORIGINS`

**`--trust-proxy`** 让网关相信前面那层代理转发的头，管两件事：

- 失败登录次数按 `X-Forwarded-For` 的首段计数，而不是按连进来的地址计数。
- 请求经 `X-Forwarded-Proto: https` 进来时，cookie 带上 `Secure`。

默认不开。不开的时候，所有经隧道进来的请求在网关眼里都是同一个本机地址：次数限制是所有人共享一份，但没人能靠伪造转发头绕过或挤掉别人。粒度粗一点，换来不能作假。

网关**直接**暴露在网络上（前面没有代理）时不要开它：那时谁都能自带这两个头，等于把限流关掉。

**`VOLTO_CORS_ORIGINS`** 只在浏览器界面的源和网关不一致时才需要（用 `next dev` 开发前端、或让网关直接伺服界面而隧道域名和网关不同源）。走下面 `volto web` 的做法时界面和转发在同一个源上，不需要它。逗号分隔，启动网关前设置：

```bash
VOLTO_CORS_ORIGINS="https://volto.example.com,http://localhost:6100" npx @volto/gateway
```

不在名单里的浏览器来源会被回 403。同源请求不需要它。网关默认只认 `http://localhost:6100` 这一个开发地址。

## 开第二个前端（可选）

只想把**界面**暴露出去、让 API 端口留在本机时，用 `volto web`：一个静态界面加一层 API 转发，对外只有一个源。

```bash
# 终端 1：网关照旧，只监听本机
npx @volto/gateway
# 终端 2：界面在 6100，把 API 转发给 3100
npx @volto/gateway web --port 6100 --gateway http://127.0.0.1:3100
```

`volto web` 打印三行，第三行 `Login:` 就是能直接登录的地址（已经带着持久 token）：

```text
volto web 0.1.0 listening on http://127.0.0.1:6100 -> http://127.0.0.1:3100
Open: http://127.0.0.1:6100/
Login: http://127.0.0.1:6100/?token=…
```

把隧道指向 6100 而不是 3100：`/?token=…` 会被转发给网关换成 cookie，cookie 落在 6100 这个源上，之后页面里所有 API 调用都带着它。

界面构建不在默认位置时用 `--web-dir`（从源码构建时就是 `apps/web/out`）：

```bash
npx @volto/gateway web --port 6100 --web-dir apps/web/out
```

`--host` 的规则和网关一致：非 loopback 必须加 `--serve-remote`。

## 已知限制

先说清楚，省得撞上才发现：

- **一段会话同时只服务一个浏览器连接。** 同一段会话在第二个标签页或第二台设备打开，会把先前的连接顶掉；被顶掉那一刻还没处理完的审批按「连接已丢失」拒绝（不是默认允许），那一轮不会继续。换设备前先关掉旧的。
- **远程模式没有原生对话框。** 选目录、在文件管理器中显示都返回 501；加工作区按上面「远程模式下加工作区」用接口做。
- **远程模式不自动开浏览器。** 打印的 `Open:` 链接仍然可用，只是不会替你弹出浏览器。
- **agent 的浏览器工具（`browser` 系列）默认会开一个可见的窗口**，而且开在网关那台机器上，不是你正在看的这台。放在没有人在跟前的机器上跑之前，改成无头：在 `~/.volto/config.json` 里设 `"browser": { "headless": true }` 再重启网关（Linux 无图形界面时会自动无头）。界面上的「设置 → 工具配置 → 浏览器」只管选哪个浏览器可执行文件，没有无头开关。
- **`volto web` 是转发层，不是隔离层。** 通过它能访问的 API 和你直连网关完全一样，别把它当「只读前端」。
- **网关那台机器等于被授予了执行权。** 就是开头那段话。

## 出问题怎么办

- **页面 401** → 用 `npx @volto/gateway token` 打印的链接重新登录（把域名换成隧道域名）。网关重启过的话，之前 `Open:` 里的启动 token 已经失效。
- **登录后发消息 403** → 浏览器来源不在 `VOLTO_CORS_ORIGINS` 里；走隧道 + `volto web` 的部署不应出现这一条，出现了说明前端和网关不在同一个源上。
- **加工作区一直失败** → 远程模式下对话框被禁用，改用接口注册路径。

更多症状见 [故障排查](./troubleshooting.md)。