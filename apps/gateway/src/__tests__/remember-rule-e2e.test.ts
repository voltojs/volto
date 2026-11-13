/**
 * shell 命令前缀规则的两条生产级验收（真实 createWiredAgent 装配 +
 * 注入的 mock model port，不用 agentFactory stub——stub 会绕过 wiring.ts，
 * 证明不了接线本身）：
 *
 * 1. spec 验收 3（2026-09-20-shell-command-prefix-rules-design.md §8.3）：
 *    记住规则后的第二次执行**不再询问**——第一次回合 bash 停在
 *    approval_asked，remember 后的第二次回合同一条命令直接放行并真实
 *    执行（tool_result 含 echo 输出），approval_asked 计数不增长。
 *    此前的 remember 测试只断言"规则写入 + 会话重建"，从未再执行一遍，
 *    验收 3 一直悬空。
 *
 * 2. 审计落盘：runner 的 rule_allow 命中必须写进生产网关的审计文件
 *    （~/.volto/audit.jsonl）。auditSink 不接线时 runner 用 no-op 默认值，
 *    命中记录全部丢弃——SAFETY 立场下"降打扰必须留痕"，这是交付项。
 */

import { describe, it, expect, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModelPort, toolCallScript, textScript } from "@voltojs/core";
import type { ModelPort } from "@voltojs/core";
import { createServer, type HeadlessServer } from "../server.js";

// 环境隔离（同 ask-user-e2e / wiring.test.ts）：规则文件、审计文件、agent
// 扫描全部挂在 VOLTO_CONFIG_DIR 与 HOME 下，不能碰真实用户目录。
const tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-remember-e2e-config-"));
const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-remember-e2e-project-"));
const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-remember-e2e-home-"));
const originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
const originalHome = process.env["HOME"];
process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
process.env["HOME"] = tempHomeDir;

afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tempProjectDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tempHomeDir, { recursive: true, force: true }).catch(() => {});
});

interface ProtocolFrame {
  id: string;
  event: string;
  data: unknown;
}

interface FrameEventPayload {
  type: string;
  data: Record<string, unknown>;
  time?: number;
}

function isEventPayload(data: unknown): data is FrameEventPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

async function until(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function post(
  base: string,
  token: string,
  pathName: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, base);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function openEventChannel(
  base: string,
  token: string,
  sessionId: string,
): { frames: ProtocolFrame[]; opened: Promise<void>; stop(): void } {
  const frames: ProtocolFrame[] = [];
  const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, base);
  let signalOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    signalOpen = resolve;
  });

  const req = http.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
    signalOpen();
    let raw = "";
    res.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
      const blocks = raw.split("\n\n");
      raw = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.includes("event: ")) continue;
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          const idx = line.indexOf(": ");
          if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
        }
        frames.push({
          id: fields["id"] ?? "",
          event: fields["event"] ?? "",
          data: JSON.parse(fields["data"] ?? "null") as unknown,
        });
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});

  return { frames, opened, stop: () => req.destroy() };
}

function eventPayloads(frames: ProtocolFrame[]): FrameEventPayload[] {
  return frames.filter((f) => f.event === "event").map((f) => f.data).filter(isEventPayload);
}

async function connectedToken(channel: ReturnType<typeof openEventChannel>): Promise<string> {
  await until(
    () => channel.frames.some((f) => f.event === "connected"),
    2000,
    "no CONNECTED frame arrived",
  );
  const frame = channel.frames.find((f) => f.event === "connected")!;
  return (frame.data as { token: string }).token;
}

/** Server + turn config bundle, same shape as ask-user-e2e's startScenario. */
async function startScenario(modelPort: ModelPort) {
  const server: HeadlessServer = await createServer({ port: 0, modelPort });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const base = `http://localhost:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  const token = server.launchToken;

  const project = (await (
    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "remember-e2e-project", path: tempProjectDir }),
    })
  ).json()) as { id: string };
  const provider = (await (
    await fetch(`${base}/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "remember-e2e-provider",
        models: [{ name: "test-model", code: "test-model" }],
      }),
    })
  ).json()) as { id: string; models: Array<{ id: string }> };

  return {
    server,
    base,
    token,
    turnConfig: {
      projectId: project.id,
      providerId: provider.id,
      modelId: provider.models[0]!.id,
    },
  };
}

describe("remembered command prefix rule in a real session (spec §8.3 + audit)", () => {
  it(
    "second execution of the remembered command runs without asking, and the rule_allow hit lands in the audit log",
    { timeout: 60_000 },
    async () => {
      const marker = "volto-remember-e2e-7f3a";
      const command = `echo ${marker}`;

      // 两个回合各两次模型调用（tool call → text）。脚本耗尽即抛错，
      // 天然证明回合结构与预期一致。
      const modelPort = createMockModelPort([
        toolCallScript("call-1", "bash", JSON.stringify({ command })),
        textScript("first turn done"),
        toolCallScript("call-2", "bash", JSON.stringify({ command })),
        textScript("second turn done"),
      ]);

      const { server, base, token, turnConfig } = await startScenario(modelPort);
      const sessionId = `remember-e2e-${Date.now()}`;
      const channel = openEventChannel(base, token, sessionId);
      try {
        await channel.opened;
        const approvalToken = await connectedToken(channel);

        // ── 回合 1：bash 停在审批上，remember 后放行 ──
        const ack1 = await post(base, token, "/messages", {
          sessionId,
          message: "run the echo command",
          permissionMode: "ask",
          ...turnConfig,
        });
        expect(ack1.status).toBe(202);

        await until(
          () => eventPayloads(channel.frames).some((e) => e.type === "approval_asked"),
          8000,
          "first turn never raised approval_asked for bash",
        );
        const asked1 = eventPayloads(channel.frames).find(
          (e) => e.type === "approval_asked",
        )!;
        const callId = asked1.data as { callId: string };
        expect(typeof callId.callId).toBe("string");

        const remember = await post(base, token, "/approvals", {
          sessionId,
          callId: callId.callId,
          decision: "allow",
          token: approvalToken,
          remember: { prefixTokens: 1 },
        });
        expect(remember.status).toBe(202);
        const rememberBody = remember.data as { remembered?: unknown; rememberError?: unknown };
        expect(rememberBody.rememberError).toBeUndefined();
        expect(rememberBody.remembered).toBeDefined();

        await until(
          () => eventPayloads(channel.frames).some((e) => e.type === "turn_end"),
          10_000,
          "first turn never completed after the approval",
        );

        // 规则确实落盘（loader 形状），permissionsDirty 才有东西可重建。
        const configPath = path.join(tempConfigDir, "config.json");
        const configRaw = await fs.readFile(configPath, "utf-8");
        expect(JSON.parse(configRaw).permissions).toEqual({
          rules: [{ toolName: "bash", commandPrefix: ["echo"], decision: "allow" }],
        });

        const askedBefore = eventPayloads(channel.frames).filter(
          (e) => e.type === "approval_asked",
        ).length;
        const turnEndsBefore = eventPayloads(channel.frames).filter(
          (e) => e.type === "turn_end",
        ).length;

        // ── 回合 2：同一条命令，规则生效——不再询问，直接执行 ──
        const ack2 = await post(base, token, "/messages", {
          sessionId,
          message: "run it again",
          permissionMode: "ask",
          ...turnConfig,
        });
        expect(ack2.status).toBe(202);

        // 30s: turn 2 pays a full session rebuild (rules reload + agent
        // rescan + fresh persistent bash / sandbox spawn). On a cold vitest
        // cache the whole suite runs heavily loaded and 15s was not enough
        // (observed once under full-suite parallelism) — this is headroom
        // for the rebuild, not slack for a hanging turn.
        try {
          await until(
            () =>
              eventPayloads(channel.frames).filter((e) => e.type === "turn_end").length >
              turnEndsBefore,
            30_000,
            "second turn never completed — remembered rule did not let the command through",
          );
        } catch (err) {
          // Failure-path dump: which frames actually arrived decides the
          // diagnosis (re-asked? never built? bash hung?) — without it a
          // suite-only timeout is indistinguishable from a logic bug.
          const summary = eventPayloads(channel.frames)
            .map((e) => {
              const d = e.data as Record<string, unknown>;
              const key =
                e.type === "tool_call"
                  ? `tool_call:${String(d["toolName"])}:${String(d["toolCallId"])}`
                  : e.type === "approval_asked"
                    ? `approval_asked:${String(d["callId"])}`
                    : e.type === "tool_result"
                      ? `tool_result:${String(d["toolCallId"])}`
                    : e.type;
              return key;
            });
          // Server-side transcript vs the SSE frames: if turn 2 exists in
          // the trajectory the channel dropped it (test harness problem);
          // if absent the turn pipeline itself never ran (server bug).
          let serverTurns = "unknown";
          try {
            const res = await fetch(
              `${base}/sessions/${encodeURIComponent(sessionId)}/events`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            const raw = await res.text();
            const starts = (raw.match(/"turn_start"/g) ?? []).length;
            const asks = (raw.match(/"approval_asked"/g) ?? []).length;
            serverTurns = `HTTP ${res.status}, persisted turn_start: ${starts}, approval_asked: ${asks}`;
          } catch (e2) {
            serverTurns = `fetch failed: ${(e2 as Error).message}`;
          }
          throw new Error(
            `${(err as Error).message}\n` +
              `server trajectory: ${serverTurns}\n` +
              `frames since start (event types): ${JSON.stringify(summary)}`,
          );
        }

        // spec §8.3：第二次执行不产生任何新的审批询问。
        const askedAfter = eventPayloads(channel.frames).filter(
          (e) => e.type === "approval_asked",
        ).length;
        expect(askedAfter).toBe(askedBefore);

        // 真实执行的正面证据：tool_result 带回 echo 的输出（不是静默跳过）。
        const turn2Results = eventPayloads(channel.frames).filter(
          (e) => e.type === "tool_result",
        );
        expect(
          turn2Results.some((e) => JSON.stringify(e.data).includes(marker)),
        ).toBe(true);

        // 审计落盘：rule_allow 命中写进网关审计文件（wiring 接了 file sink）。
        const auditPath = path.join(tempConfigDir, "audit.jsonl");
        const auditRaw = await fs.readFile(auditPath, "utf-8");
        const entries = auditRaw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const ruleAllow = entries.find((e) => e["kind"] === "rule_allow");
        expect(ruleAllow, "no rule_allow entry in the audit log").toBeDefined();
        expect(ruleAllow!["toolName"]).toBe("bash");
        expect(String(ruleAllow!["commandText"])).toContain(marker);
        expect(String(ruleAllow!["ruleSummary"])).toContain("commandPrefix:echo");
      } finally {
        channel.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
