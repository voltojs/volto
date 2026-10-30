/**
 * Model routing tiers in the sub-agent dispatch chain (spec 2026-10-29 D3-D6).
 *
 * With a `routingTiers` table configured, every model reference on a dispatch
 * — the per-dispatch `model` input first, the definition's `model:` second —
 * is a tier id, never a raw model code. The two audiences split exactly as
 * design D5 pins: a per-dispatch id that is not in the table — or that names
 * an unassigned (`target: null`) tier (spec v2 D8) — is the caller's own
 * mistake and fails loudly (the model can self-correct); a definition id that
 * is not in the table, or a tier whose target no longer resolves (unassigned
 * included), degrades visibly to the parent model with a
 * `subagent_model_tier_unresolved` event on the main feed.
 *
 * A tier may also carry a `reasoningEffort` (spec v2 D10). It slots between
 * the definition's own effort and the parent's — definition > tier > parent —
 * and only rides on a fully resolved tier: a degraded dispatch has no resolved
 * tier and falls back to the parent's effort with no special handling.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent } from "../create-agent.js";
import type { AgentSpec } from "../agent-spec.js";
import type { AgentEntry } from "../agent-registry/scan.js";
import type {
  EventSink,
  ModelEvent,
  ModelPort,
  ModelRequest,
  ToolDefinition,
  ToolResult,
  TranscriptEventInput,
} from "@volto/core";
import { createMockModelPort, textScript, toolCallScript } from "@volto/core";
import { createNodeFileSystem, createNodeAttachmentStore } from "@volto/runtime-node";
import type { Tool } from "@volto/tools-common";

/** Wrap a scripted mock port so every ModelRequest it serves is captured. */
function recordingModelPort(script: ModelEvent[][]) {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  const port: ModelPort = {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(req);
      yield* inner.stream(req);
    },
  };
  return { port, requests };
}

function agentEntry(spec: AgentSpec): AgentEntry {
  return { id: `plugin:${spec.name}`, scope: "plugin", spec, shadowed: false };
}

/** Flatten a ToolResult's modelContent (string or block array) into plain text. */
function textOf(modelContent: ToolResult["modelContent"]): string {
  if (modelContent === undefined) return "";
  if (typeof modelContent === "string") return modelContent;
  return modelContent
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Capture sink for the parent-feed events. `time` is read like the gateway's frame() does. */
function captureSink(): {
  sink: EventSink;
  events: Array<{ type: string; data: Record<string, unknown>; time?: number }>;
} {
  const events: Array<{ type: string; data: Record<string, unknown>; time?: number }> = [];
  const sink: EventSink = {
    emit(event) {
      events.push(event);
    },
  };
  return { sink, events };
}

const PREMIUM_TIER = { id: "premium", target: { providerId: "p1", modelId: "big" } };
const ECONOMY_TIER = { id: "economy", target: { providerId: "p1", modelId: "small" } };

describe("sub-agent model tier routing", () => {
  it("per-dispatch 未知档位 → dispatch throw", async () => {
    // The dispatch wrapped by createTaskTool receives model: "nope", which is
    // not in the tier table. It must reject with the exact signature (the
    // task tool's catch normalizes the rejection into an isError result the
    // model can act on) BEFORE any child runner — and thus any provider I/O —
    // exists: the fake port must receive no model call at all.
    const { port, requests } = recordingModelPort([]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      routingTiers: [PREMIUM_TIER],
    });
    const taskTool = agent.tools.find((t) => t.definition.name === "task");
    expect(taskTool).toBeDefined();

    const result = await taskTool!.handler({ message: "go", model: "nope" });

    expect(result.isError).toBe(true);
    expect(textOf(result.modelContent)).toMatch(
      /Unknown model tier "nope"\. Available tiers: premium/,
    );
    expect(requests).toHaveLength(0);
  });

  it("spec 引用未知档位 → 降级继承 + 事件", async () => {
    const { sink, events } = captureSink();
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "ghosty" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      eventSink: sink,
      routingTiers: [PREMIUM_TIER],
      agentSpecs: [agentEntry({ name: "ghosty", model: "ghost" })],
    });

    await agent.run("dispatch the ghosty agent");

    // The child still runs — on the parent's model. The unresolved tier id
    // must never reach the provider as a model code.
    expect(requests).toHaveLength(3);
    expect(requests[1]!.model).toBe("parent-model");
    expect(requests[1]!.model).toBe(requests[0]!.model);

    const unresolved = events.find((e) => e.type === "subagent_model_tier_unresolved");
    expect(unresolved).toBeDefined();
    expect(unresolved!.data).toMatchObject({ subagentType: "ghosty", tierId: "ghost" });
    // F-023 shape: parent-level event carrying the turn stamp.
    expect(typeof unresolved!.data["turn"]).toBe("number");
    // Envelope stamp: the gateway's frame() drops events without a top-level
    // numeric `time` (sessions.ts asTranscriptEvent).
    expect(typeof unresolved!.time).toBe("number");
  });

  it("unassigned null-target tier degrades without calling the factory", async () => {
    // Task-9 brief cases 2 and 6, PINNING (written green — no RED phase):
    // task 8 already landed this guard while adapting `target: null` for the
    // server side, so these assertions pin that behavior rather than drive
    // it. Spec v2 D7/D8: `target: null` is a legal "unassigned" tier. A
    // definition reference to it degrades exactly like a dead target — the
    // factory must not be called at all, and the unresolved event names the
    // tier without a target. (A per-dispatch reference to such a tier throws
    // instead — covered separately below.)
    const { sink, events } = captureSink();
    const factoryCalls: Array<{ providerId: string; modelId: string }> = [];
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "budgety" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      eventSink: sink,
      routingTiers: [{ id: "economy", target: null }],
      resolveSubagentModelPort: async (target) => {
        factoryCalls.push(target);
        return { modelPort: port, model: "never-used" };
      },
      agentSpecs: [agentEntry({ name: "budgety", model: "economy" })],
    });

    await agent.run("dispatch the budgety agent");

    expect(factoryCalls).toEqual([]);
    // The child still runs — on the parent's model.
    expect(requests).toHaveLength(3);
    expect(requests[1]!.model).toBe("parent-model");
    const unresolved = events.find((e) => e.type === "subagent_model_tier_unresolved");
    expect(unresolved).toBeDefined();
    expect(unresolved!.data).toMatchObject({ subagentType: "budgety", tierId: "economy" });
    expect(unresolved!.data).not.toHaveProperty("target");
  });

  it("档位命中同 provider → 子 runner 用档位模型", async () => {
    const { port: parentPort, requests: parentRequests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "child job", model: "economy" })),
      textScript("parent done"),
    ]);
    const { port: portA, requests: portARequests } = recordingModelPort([
      textScript("child done"),
    ]);
    const factoryCalls: Array<{ providerId: string; modelId: string }> = [];
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      enableTaskTool: true,
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async (target) => {
        factoryCalls.push(target);
        return { modelPort: portA, model: "small" };
      },
    });

    await agent.run("do the work");

    expect(factoryCalls).toEqual([{ providerId: "p1", modelId: "small" }]);
    // The child's model call runs on the factory's port under the tier model.
    expect(portARequests).toHaveLength(1);
    expect(portARequests[0]!.model).toBe("small");
    expect(portARequests[0]!.messages.map((m) => m.content)).toContain("child job");
    // The parent port served only the parent's own two calls.
    expect(parentRequests).toHaveLength(2);
  });

  it("档位命中跨 provider → 换 port", async () => {
    const { port: parentPort, requests: parentRequests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "child job", model: "economy" })),
      textScript("parent done"),
    ]);
    const { port: portB, requests: portBRequests } = recordingModelPort([
      textScript("child done"),
    ]);
    // Child transcript capture — the assistant_message.source stamp is where
    // the routed provider id surfaces (review Important #1).
    const written: Array<{ sessionId: string; event: TranscriptEventInput }> = [];
    const chatStore = {
      async appendEvents(sessionId: string, events: TranscriptEventInput[]) {
        for (const event of events) written.push({ sessionId, event });
      },
    };
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      providerId: "parent-provider",
      enableTaskTool: true,
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async () => ({ modelPort: portB, model: "small" }),
      chatStore,
      chatSessionId: "s1",
    });

    await agent.run("do the work");

    // The child ran on the factory's (other-provider) port B…
    expect(portBRequests).toHaveLength(1);
    expect(portBRequests[0]!.model).toBe("small");
    expect(portBRequests[0]!.messages.map((m) => m.content)).toContain("child job");
    // …and never on the parent's port: only the parent's two calls landed there.
    expect(parentRequests).toHaveLength(2);
    expect(
      parentRequests.some((r) =>
        r.messages.some((m) => m.role === "user" && m.content === "child job"),
      ),
    ).toBe(false);
    // The child's assistant_message.source names the TIER's target provider,
    // not the parent's routing provider (spec D6 acceptance 6).
    const childAssistant = written.find(
      (w) => w.sessionId.startsWith("s1-sub-") && w.event.type === "assistant_message",
    );
    expect(childAssistant).toBeDefined();
    expect(childAssistant!.event.data).toMatchObject({
      source: { providerId: "p1", modelId: "small" },
    });
  });

  it("工厂返回 null → 降级 + 事件（data 含失效 target）", async () => {
    const { sink, events } = captureSink();
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "child job", model: "economy" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      eventSink: sink,
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async () => null,
    });

    await agent.run("do the work");

    // Degrade = inherit the parent model, same as an unresolved definition
    // tier — the dead target must never reach the provider.
    expect(requests).toHaveLength(3);
    expect(requests[1]!.model).toBe("parent-model");

    const unresolved = events.find((e) => e.type === "subagent_model_tier_unresolved");
    expect(unresolved).toBeDefined();
    expect(unresolved!.data).toMatchObject({
      tierId: "economy",
      target: { providerId: "p1", modelId: "small" },
    });
    expect(typeof unresolved!.data["turn"]).toBe("number");
    expect(typeof unresolved!.time).toBe("number");
  });

  it("工厂 throw → 降级 + 事件（与返回 null 同规则）", async () => {
    const { sink, events } = captureSink();
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "child job", model: "economy" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      eventSink: sink,
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async () => {
        throw new Error("provider store is down");
      },
    });

    await agent.run("do the work");

    expect(requests).toHaveLength(3);
    expect(requests[1]!.model).toBe("parent-model");

    const unresolved = events.find((e) => e.type === "subagent_model_tier_unresolved");
    expect(unresolved).toBeDefined();
    expect(unresolved!.data).toMatchObject({
      tierId: "economy",
      target: { providerId: "p1", modelId: "small" },
    });
  });

  it("后台派发（run_in_background）引用未知 spec 档位 → 事件仍在主 feed sink", async () => {
    // The detached child runs degraded on the parent model; the turn-boundary
    // drain awaits it (and reopens the turn for the fold-in), so the run's
    // completion guarantees the event was already emitted. All non-first
    // scripts are plain text: the child's call races the parent's next one
    // and either assignment completes.
    const { sink, events } = captureSink();
    const { port } = recordingModelPort([
      toolCallScript(
        "m1",
        "task",
        JSON.stringify({ message: "bg job", subagent_type: "ghosty", run_in_background: true }),
      ),
      textScript("Sub-agent result text"),
      textScript("Understood, I will collect it later."),
      textScript("Folded the background result in."),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      eventSink: sink,
      routingTiers: [PREMIUM_TIER],
      agentSpecs: [agentEntry({ name: "ghosty", model: "ghost" })],
    });

    await agent.run("start a background task");

    const unresolved = events.find((e) => e.type === "subagent_model_tier_unresolved");
    expect(unresolved).toBeDefined();
    expect(unresolved!.data).toMatchObject({ subagentType: "ghosty", tierId: "ghost" });
    // Main feed, not a child bucket: parent-level events carry no agentDepth tag.
    expect(unresolved!.data["agentDepth"]).toBeUndefined();
  });

  it("嵌套派发：孙级 dispatch 同样解析档位", async () => {
    const { port: parentPort } = recordingModelPort([
      toolCallScript("p1", "task", JSON.stringify({ message: "level one", subagent_type: "lead" })),
      toolCallScript("c1", "task", JSON.stringify({ message: "level two", model: "economy" })),
      textScript("child done"),
      textScript("parent done"),
    ]);
    const { port: portA, requests: portARequests } = recordingModelPort([
      textScript("grandchild done"),
    ]);
    const factoryCalls: Array<{ providerId: string; modelId: string }> = [];
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      enableTaskTool: true,
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async (target) => {
        factoryCalls.push(target);
        return { modelPort: portA, model: "small" };
      },
      agentSpecs: [agentEntry({ name: "lead", tools: ["task"] })],
    });

    await agent.run("delegate twice");

    // The grandchild's dispatch resolved the tier through the factory.
    expect(factoryCalls).toEqual([{ providerId: "p1", modelId: "small" }]);
    expect(portARequests).toHaveLength(1);
    expect(portARequests[0]!.model).toBe("small");
    expect(portARequests[0]!.messages.map((m) => m.content)).toContain("level two");
  });

  it("事件信封带顶层 time（tier 降级与权限降级同批断言）", async () => {
    // The gateway's frame() drops envelopes without a numeric top-level
    // `time` (sessions.ts asTranscriptEvent), so both parent-level dispatch
    // events must be stamped at the emit site (review fix round 2). One
    // dispatch here trips BOTH events: the definition references an unknown
    // tier AND asks for a wider policy than the parent allows.
    const { sink, events } = captureSink();
    const { port } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "risky" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      eventSink: sink,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
      routingTiers: [PREMIUM_TIER],
      agentSpecs: [
        agentEntry({
          name: "risky",
          model: "ghost",
          policy: { sandbox: "danger-full-access", approval: "never" },
        }),
      ],
    });

    await agent.run("dispatch the risky agent");

    const downgrade = events.find((e) => e.type === "subagent_permission_downgraded");
    const unresolved = events.find((e) => e.type === "subagent_model_tier_unresolved");
    expect(downgrade).toBeDefined();
    expect(unresolved).toBeDefined();
    expect(typeof downgrade!.time).toBe("number");
    expect(typeof unresolved!.time).toBe("number");
  });
});

// ──────────────────────────────────────────────
// Unassigned (null-target) tiers and tier-carried reasoning effort
// ──────────────────────────────────────────────

describe("sub-agent model tier routing — null targets and tier effort", () => {
  it("per-dispatch null-target tier reference fails with has no assigned model", async () => {
    // Task-9 brief case 1 (behavioral). A per-dispatch reference to a tier
    // whose target is null is the caller's own mistake, exactly like an
    // unknown id: the dispatch must reject with the pinned signature (the
    // task tool's catch normalizes it into an isError result the model can
    // self-correct from) BEFORE any child runner — and any provider I/O —
    // exists. Full message, verbatim from the brief:
    //   model tier "economy" has no assigned model. Available tiers: premium, economy
    // The available list renders the table's ids in order — the same list the
    // unknown-tier error prints.
    const factoryCalls: Array<{ providerId: string; modelId: string }> = [];
    const { port, requests } = recordingModelPort([]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      enableTaskTool: true,
      routingTiers: [PREMIUM_TIER, { id: "economy", target: null }],
      resolveSubagentModelPort: async (target) => {
        factoryCalls.push(target);
        return { modelPort: port, model: "never-used" };
      },
    });
    const taskTool = agent.tools.find((t) => t.definition.name === "task");
    expect(taskTool).toBeDefined();

    const result = await taskTool!.handler({ message: "go", model: "economy" });

    expect(result.isError).toBe(true);
    const text = textOf(result.modelContent);
    expect(text).toContain("has no assigned model");
    expect(text).toContain('model tier "economy"');
    expect(text).toContain("Available tiers: premium, economy");
    // Zero provider I/O: no model call, and the factory (the only door to a
    // provider port) was never reached either.
    expect(requests).toHaveLength(0);
    expect(factoryCalls).toEqual([]);
  });

  it("a tier-carried reasoningEffort reaches the child run when the definition has none", async () => {
    // Task-9 brief case 3 (behavioral). Spec v2 D10 chain: definition >
    // tier > parent. The definition is silent, so the resolved tier's effort
    // applies to the child's model calls — and only a fully resolved tier
    // carries one (the factory hit below is what makes it resolved).
    const { port: parentPort } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "worker" })),
      textScript("parent done"),
    ]);
    const { port: portA, requests: childRequests } = recordingModelPort([
      textScript("child done"),
    ]);
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      reasoningEffort: "medium",
      enableTaskTool: true,
      routingTiers: [
        { id: "economy", target: { providerId: "p1", modelId: "small" }, reasoningEffort: "high" },
      ],
      resolveSubagentModelPort: async () => ({ modelPort: portA, model: "small" }),
      agentSpecs: [agentEntry({ name: "worker", model: "economy" })],
    });

    await agent.run("delegate");

    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]!.reasoningEffort).toBe("high");
  });

  it("the definition's reasoningEffort outranks the tier's", async () => {
    // Task-9 brief case 4 (chain-order guard). Definition > tier > parent:
    // all three levels disagree ("low" / "high" / "medium"), and the
    // definition's explicit effort must win (spec acceptance 10).
    const { port: parentPort } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "worker" })),
      textScript("parent done"),
    ]);
    const { port: portA, requests: childRequests } = recordingModelPort([
      textScript("child done"),
    ]);
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      reasoningEffort: "medium",
      enableTaskTool: true,
      routingTiers: [
        { id: "economy", target: { providerId: "p1", modelId: "small" }, reasoningEffort: "high" },
      ],
      resolveSubagentModelPort: async () => ({ modelPort: portA, model: "small" }),
      agentSpecs: [
        agentEntry({ name: "worker", model: "economy", reasoningEffort: "low" }),
      ],
    });

    await agent.run("delegate");

    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]!.reasoningEffort).toBe("low");
  });

  it("a child whose tier and definition both omit effort inherits the parent's", async () => {
    // Task-9 brief case 5 (no-regression guard for the existing chain):
    // neither level configures an effort, so the child runs with the
    // parent's — unchanged legacy behavior through a resolved tier.
    const { port: parentPort } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "worker" })),
      textScript("parent done"),
    ]);
    const { port: portA, requests: childRequests } = recordingModelPort([
      textScript("child done"),
    ]);
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      reasoningEffort: "medium",
      enableTaskTool: true,
      routingTiers: [{ id: "economy", target: { providerId: "p1", modelId: "small" } }],
      resolveSubagentModelPort: async () => ({ modelPort: portA, model: "small" }),
      agentSpecs: [agentEntry({ name: "worker", model: "economy" })],
    });

    await agent.run("delegate");

    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]!.reasoningEffort).toBe("medium");
  });

  it("a degraded tier contributes no reasoningEffort to the child", async () => {
    // Guard for the degrade path (task 9 notes): the tier's effort rides on
    // the RESOLVED tier only. Here the factory reports the target dead, the
    // child degrades to the parent's model — whose per-call effort gate may
    // not accept this tier's value at all — so the effort must fall back to
    // the parent's with no special handling. (Green before and after the
    // chain change: the pre-chain code never saw tier effort either.)
    const { port, requests } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", subagent_type: "worker" })),
      textScript("sub done"),
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: port,
      model: "parent-model",
      reasoningEffort: "medium",
      enableTaskTool: true,
      routingTiers: [
        { id: "economy", target: { providerId: "p1", modelId: "small" }, reasoningEffort: "high" },
      ],
      resolveSubagentModelPort: async () => null,
      agentSpecs: [agentEntry({ name: "worker", model: "economy" })],
    });

    await agent.run("delegate");

    // The degraded child ran on the parent port (request #1) with the
    // parent's effort, never the tier's.
    expect(requests).toHaveLength(3);
    expect(requests[1]!.reasoningEffort).toBe("medium");
  });
});

// ──────────────────────────────────────────────
// Tier hit extras: the factory's vision gate and context window
// ──────────────────────────────────────────────

/** 1×1 red PNG — same fixture as image-pipeline-e2e. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => {});
  }
});

/** Temp workspace holding FIXTURE.png + a sibling temp attachment root. */
async function makeImageWorkspace(): Promise<{
  fs: ReturnType<typeof createNodeFileSystem>;
  attachmentStore: ReturnType<typeof createNodeAttachmentStore>;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "volto-tier-vision-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "ws");
  const attachmentRoot = path.join(base, "att");
  await mkdir(root, { recursive: true });
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(path.join(root, "FIXTURE.png"), Buffer.from(PNG_1X1, "base64"));
  return {
    fs: createNodeFileSystem({ root }),
    attachmentStore: createNodeAttachmentStore({
      rootDir: attachmentRoot,
      sessionId: "sess-tier-vision",
    }),
  };
}

/** The isError flag and joined text of one tool_result as the model sees it. */
function toolResultOf(
  req: ModelRequest,
  toolUseId: string,
): { isError: boolean; text: string } {
  for (const m of req.messages) {
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result" || block.toolUseId !== toolUseId) continue;
      const parts = Array.isArray(block.content)
        ? block.content
        : [{ type: "text" as const, text: String(block.content) }];
      const text = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      return { isError: block.isError === true, text };
    }
  }
  throw new Error(`no tool_result for ${toolUseId} in request`);
}

const ECHO_DEF: ToolDefinition = {
  name: "echo",
  description: "Return a fixed-size payload",
  inputSchema: { type: "object", properties: {} },
  requires: ["test:echo"],
  riskTier: "READ_ONLY",
};

function echoTool(chars: number): Tool {
  return {
    definition: ECHO_DEF,
    handler: async () => ({ modelContent: "x".repeat(chars) }),
  };
}

const SUMMARY_PROMPT_ID = "compaction-summary-prompt";
const SUMMARY_PREFIX = "[Earlier conversation summary]";

/**
 * Stateful child port (same shape as compaction-window's makePort): keeps
 * requesting `echo` so the conversation crosses the compaction threshold,
 * answers the synthetic summarization call, and finishes once it sees the
 * summary. Capped so a wrong (too high) threshold fails instead of looping.
 */
function compactionAwarePort(maxToolRounds: number): {
  port: ModelPort;
  requests: ModelRequest[];
} {
  let rounds = 0;
  const requests: ModelRequest[] = [];
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);
      if (req.messages.length === 1 && req.messages[0]?.id === SUMMARY_PROMPT_ID) {
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "text_delta", text: "SUMMARY" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      if (
        req.messages.some(
          (m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX),
        )
      ) {
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      rounds += 1;
      if (rounds > maxToolRounds) {
        yield { type: "text_delta", text: "stop" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      yield { type: "usage", inputTokens: 100, outputTokens: 10 };
      yield { type: "tool_use_start", toolCallId: `c${rounds}`, toolName: "echo" };
      yield { type: "tool_use_delta", toolCallId: `c${rounds}`, argumentsDelta: "{}" };
      yield { type: "done", stopReason: "tool_use" };
    },
  };
  return { port, requests };
}

describe("sub-agent model tier routing — factory extras", () => {
  it("档位命中 visionSupported=false → 子代理图片读取被拒", async () => {
    // The parent's own modelVision is unknown (undefined → do not gate), so
    // only the tier's explicit `false` can refuse the child's image read.
    const { fs, attachmentStore } = await makeImageWorkspace();
    const { port: parentPort } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "read the image", model: "economy" })),
      textScript("parent done"),
    ]);
    const { port: portA, requests: portARequests } = recordingModelPort([
      toolCallScript("c2", "read_file", JSON.stringify({ path: "FIXTURE.png" })),
      textScript("child done"),
    ]);
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      enableTaskTool: true,
      fs,
      attachmentStore,
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async () => ({
        modelPort: portA,
        model: "small",
        visionSupported: false,
      }),
    });

    await agent.run("read the image file");

    expect(portARequests).toHaveLength(2);
    const refusal = toolResultOf(portARequests[1]!, "c2");
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain("The current model does not support image input.");
  });

  it("档位命中 contextWindow → 子代理 compaction 阈值按档位窗口推导", async () => {
    // Parent window 100k (threshold 60k under the pinned ratio/headroom); the
    // tier reports a 10k window, so the child's threshold must derive from
    // 10k (→ 6k) and compact mid-run. Without the tier window the child
    // inherits the parent's 60k threshold and no summarization call happens
    // within this message volume.
    const { port: parentPort } = recordingModelPort([
      toolCallScript("c1", "task", JSON.stringify({ message: "go", model: "economy" })),
      textScript("parent done"),
    ]);
    const { port: portA, requests: portARequests } = compactionAwarePort(40);
    const agent = createAgent({
      modelPort: parentPort,
      model: "parent-model",
      enableTaskTool: true,
      tools: [echoTool(2_000)],
      capabilities: new Set(["test:echo"]),
      contextWindow: 100_000,
      compaction: { recentKeepCount: 1, windowRatio: 0.6, headroomTokens: 1_000 },
      routingTiers: [ECONOMY_TIER],
      resolveSubagentModelPort: async () => ({
        modelPort: portA,
        model: "small",
        contextWindow: 10_000,
      }),
    });

    await agent.run("do the work");

    const summarized = portARequests.some(
      (r) => r.messages.length === 1 && r.messages[0]?.id === SUMMARY_PROMPT_ID,
    );
    expect(summarized).toBe(true);
  });
});
