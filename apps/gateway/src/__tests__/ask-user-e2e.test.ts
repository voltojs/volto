/**
 * ask_user 端到端（网关侧）——Task 7b 的验收集成测试。
 *
 * 覆盖此前断裂的链路（走真实 createWiredAgent 装配 + 注入的 mock model port，
 * 不用 agentFactory stub——stub 会绕过 wiring.ts，证明不了接线本身）：
 *
 * 1. FIX A：wiring 把 session.approvals.gate 同时作为 askUserGate 传入
 *    createAgent。此前 SDK 默认 auto-allow，ask_user 直接"用户回答：yes"，
 *    问题永远到不了用户——本测试断言回合真的 park 在 gate 上（第二次模型
 *    调用只在 POST /approvals 结算后才发生）。
 * 2. FIX B：ask_user 工具 emit 的 prompt 事件经 wiring 的 eventSink 适配器
 *    到达该会话的活跃 /events 连接。此前装配没传 eventSink（进 no-op），
 *    且 frame() 丢弃无 transcript 戳的裸事件，web 看不到任何卡片数据。
 * 3. ask_user 直接调 gate、绕过 Runner 审批流，没有原生 approval_asked /
 *    approval_decision 事件；网关为它合成这两个事件（仅 toolName 为
 *    ask_user 的调用——普通审批仍由 Runner 发原生事件，不重复）。没有
 *    approval_asked，web 派生（selectPendingApprovals）不会出卡片；没有
 *    approval_decision，答完的卡片永不消失。
 * 4. POST /approvals 携带 answer 结算后，工具结果以 "用户回答：…" 回给模型，
 *    回合继续完成——问题、答案、回合闭环。
 */

import { describe, it, expect, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModelPort, toolCallScript, textScript } from "@volto/core";
import type { ModelPort } from "@volto/core";
import { createServer, type HeadlessServer } from "../server.js";

// ── 环境隔离（同 wiring.test.ts：指令/技能扫描挂在 $HOME 与 VOLTO_CONFIG_DIR 下）──
const tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-user-config-"));
const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-user-project-"));
const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-user-home-"));
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

/** Event-frame payload shape on the wire (transcript-stamped or gateway-synthesized). */
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

/** Resolves once `pred` holds (polling every 25ms); rejects after `timeoutMs`. */
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
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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

/**
 * Open a raw /events channel and collect every protocol frame until stop().
 * Mirrors server.test.ts's openEventChannel: never resolves on its own, so
 * tests synchronize with until() over the collected frames.
 */
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
        if (!block.includes("event: ")) continue; // the ": connected" comment
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
    res.on("error", () => {
      // The deliberate destroy() below surfaces here — expected.
    });
  });
  req.on("error", () => {
    // Same on the request side.
  });

  return { frames, opened, stop: () => req.destroy() };
}

/** The event payloads carried by `event` frames, in arrival order. */
function eventPayloads(frames: ProtocolFrame[]): FrameEventPayload[] {
  return frames.filter((f) => f.event === "event").map((f) => f.data).filter(isEventPayload);
}

/** Extract the per-connection approval token from the CONNECTED frame. */
async function connectedToken(channel: ReturnType<typeof openEventChannel>): Promise<string> {
  await until(
    () => channel.frames.some((f) => f.event === "connected"),
    2000,
    "no CONNECTED frame arrived",
  );
  const frame = channel.frames.find((f) => f.event === "connected")!;
  return (frame.data as { token: string }).token;
}

/** Server + channel + model script bundle for one scenario. */
async function startScenario(modelPort: ModelPort) {
  const server: HeadlessServer = await createServer({ port: 0, modelPort });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const base = `http://localhost:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  const token = server.launchToken;

  // A turn through POST /messages must name a resolvable project/provider/model.
  const project = (await (
    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "ask-user-project", path: tempProjectDir }),
    })
  ).json()) as { id: string };
  const provider = (await (
    await fetch(`${base}/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "ask-user-provider",
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

describe("ask_user 端到端（网关接线）", () => {
  it("allow + answer：ask_user 事件到达 SSE，合成审批括号，答案回到工具结果，回合完成", async () => {
    const modelPort = createMockModelPort([
      toolCallScript(
        "call-1",
        "ask_user",
        JSON.stringify({
          question: "选哪个数据库？",
          options: [{ label: "SQLite" }, { label: "Postgres" }],
          multiSelect: false,
        }),
      ),
      // 第二次模型调用只在 gate 结算后发生——脚本耗尽即抛错，天然证明回合曾 park。
      textScript("好的，用 SQLite。"),
    ]);
    const { server, base, token, turnConfig } = await startScenario(modelPort);
    const sessionId = `ask-user-e2e-${Date.now()}`;
    const channel = openEventChannel(base, token, sessionId);
    try {
      await channel.opened;
      const approvalToken = await connectedToken(channel);

      const ack = await post(base, token, "/messages", {
        sessionId,
        message: "问我用哪个数据库",
        permissionMode: "ask",
        ...turnConfig,
      });
      expect(ack.status).toBe(202);

      // FIX B：ask_user 工具的 prompt 事件必须到达会话 SSE（此前 no-op sink，
      // 一个都收不到）。字段完整性：callId / question / options / multiSelect。
      await until(
        () => eventPayloads(channel.frames).some((e) => e.type === "ask_user"),
        8000,
        "ask_user event never reached the session SSE channel",
      );
      const askEvent = eventPayloads(channel.frames).find((e) => e.type === "ask_user")!;
      const askData = askEvent.data as {
        callId?: unknown;
        question?: unknown;
        options?: unknown;
        multiSelect?: unknown;
      };
      expect(typeof askData.callId).toBe("string");
      expect(askData.callId).not.toBe("");
      expect(askData.question).toBe("选哪个数据库？");
      expect(askData.options).toEqual([{ label: "SQLite" }, { label: "Postgres" }]);
      expect(askData.multiSelect).toBe(false);

      // 卡片生存周期（合成 approval_asked）：与 ask_user 事件共用同一个
      // gate-facing callId，web 派生据此出卡片。没有它，裸 ask_user 事件
      // 永远不会自建 pending 条目。
      const callId = askData.callId as string;
      await until(
        () =>
          eventPayloads(channel.frames).some(
            (e) =>
              e.type === "approval_asked" &&
              (e.data as { callId?: string }).callId === callId,
          ),
        8000,
        `no synthetic approval_asked for gate callId ${callId}`,
      );
      const asked = eventPayloads(channel.frames).find(
        (e) => e.type === "approval_asked" && (e.data as { callId?: string }).callId === callId,
      )!;
      expect((asked.data as { name?: string }).name).toBe("ask_user");
      expect((asked.data as { riskTier?: string }).riskTier).toBe("READ_ONLY");

      // FIX A 的可观察证据：回合真的 park（第二次模型调用未发生——若 SDK
      // 默认 auto-allow 生效，这里早已收到 turn_end）。
      expect(eventPayloads(channel.frames).some((e) => e.type === "turn_end")).toBe(false);

      // T4 的结算路径：连接 token + 用户答案。
      const settle = await post(base, token, "/approvals", {
        sessionId,
        callId,
        decision: "allow",
        token: approvalToken,
        answer: ["SQLite"],
      });
      expect(settle.status).toBe(202);

      // 回合完成（错误不中断主循环的反面证明：park 后恢复而不是挂死）。
      await until(
        () => eventPayloads(channel.frames).some((e) => e.type === "turn_end"),
        10000,
        "turn never completed after the approval was settled",
      );

      // 合成 approval_decision：web 派生据此清卡。
      const decision = eventPayloads(channel.frames).find(
        (e) =>
          e.type === "approval_decision" &&
          (e.data as { callId?: string }).callId === callId,
      );
      expect(decision).toBeDefined();
      expect((decision!.data as { decision?: string }).decision).toBe("allow");

      // ask_user 工具结果含用户的回答——答案真正回到模型可见的上下文。
      const toolResult = eventPayloads(channel.frames).find(
        (e) =>
          e.type === "tool_result" &&
          (e.data as { name?: string }).name === "ask_user",
      );
      expect(toolResult).toBeDefined();
      expect(JSON.stringify(toolResult!.data)).toContain("User answer: SQLite");

      // 回合继续：第二次模型调用的回复也到达（同一 turn 的收尾）。
      expect(
        eventPayloads(channel.frames).some(
          (e) =>
            e.type === "assistant_message" &&
            JSON.stringify(e.data).includes("好的，用 SQLite。"),
        ),
      ).toBe(true);
    } finally {
      channel.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("deny（跳过）：合成 approval_decision 为 deny，工具结果非报错，回合照常完成", async () => {
    const modelPort = createMockModelPort([
      toolCallScript(
        "call-1",
        "ask_user",
        JSON.stringify({ question: "继续之前还有什么偏好吗？" }),
      ),
      textScript("明白，按默认来。"),
    ]);
    const { server, base, token, turnConfig } = await startScenario(modelPort);
    const sessionId = `ask-user-deny-${Date.now()}`;
    const channel = openEventChannel(base, token, sessionId);
    try {
      await channel.opened;
      const approvalToken = await connectedToken(channel);

      const ack = await post(base, token, "/messages", {
        sessionId,
        message: "问我偏好",
        permissionMode: "ask",
        ...turnConfig,
      });
      expect(ack.status).toBe(202);

      await until(
        () => eventPayloads(channel.frames).some((e) => e.type === "ask_user"),
        8000,
        "ask_user event never reached the session SSE channel",
      );
      const askEvent = eventPayloads(channel.frames).find((e) => e.type === "ask_user")!;
      const callId = (askEvent.data as { callId?: string }).callId!;

      const settle = await post(base, token, "/approvals", {
        sessionId,
        callId,
        decision: "deny",
        token: approvalToken,
      });
      expect(settle.status).toBe(202);

      await until(
        () => eventPayloads(channel.frames).some((e) => e.type === "turn_end"),
        10000,
        "turn never completed after the deny",
      );

      const decision = eventPayloads(channel.frames).find(
        (e) =>
          e.type === "approval_decision" &&
          (e.data as { callId?: string }).callId === callId,
      );
      expect((decision!.data as { decision?: string }).decision).toBe("deny");

      // deny 是"用户未回答"，不是错误——模型被告知可继续，turn 照常收尾。
      const toolResult = eventPayloads(channel.frames).find(
        (e) =>
          e.type === "tool_result" &&
          (e.data as { name?: string }).name === "ask_user",
      )!;
      expect((toolResult.data as { isError?: boolean }).isError).toBe(false);
      expect(JSON.stringify(toolResult.data)).toContain("The user did not answer this question");
    } finally {
      channel.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
