import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../create-agent.js";
import type { CreateAgentOptions } from "../create-agent.js";
import { textScript, toolCallScript } from "@voltojs/core";
import type { ModelPort, ModelRequest } from "@voltojs/core";
import type { LspClient, LspClientProvider } from "@voltojs/tools/code";
import type { DatabaseAdapter, DatabaseOpener } from "@voltojs/tools/data";

/**
 * F-122 — SDK options, capability split and assembly.
 *
 * The provider / opener here are contract stubs: the raw I/O behind them is
 * covered by the runtime tasks (real LSP subprocess, real sqlite). What this
 * suite asserts is the wiring the SDK owns — which capability is granted from
 * which option, what that makes visible on the real `ModelRequest` tool list,
 * what a sub-agent may inherit, and what `dispose()` reaps.
 */

const REQUESTS: ModelRequest[] = [];
const modelPort: ModelPort = {
  async *stream(req) {
    REQUESTS.push(req);
    yield* textScript("ok");
  },
};

function stubClient(): LspClient {
  return {
    async definition() {
      return [
        {
          uri: "file:///src/a.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ];
    },
    async references() {
      return [];
    },
    async rename() {
      return {};
    },
    async diagnostics() {
      return { diagnostics: [], source: "pull" as const };
    },
    async hover() {
      return null;
    },
  };
}

function stubProvider(): LspClientProvider & { dispose(): Promise<void> } {
  return {
    async forFile() {
      return stubClient();
    },
    async dispose() {
      return undefined;
    },
  };
}

function stubAdapter(): DatabaseAdapter {
  return {
    async query() {
      return [];
    },
    async exec() {
      return { changes: 0 };
    },
  };
}

function stubOpener(): DatabaseOpener {
  return {
    async open() {
      return stubAdapter();
    },
    async closeAll() {
      return undefined;
    },
  };
}

/** Run one turn and return the tool names the model actually saw. */
async function captureModelRequestTools(
  opts: Partial<CreateAgentOptions>,
): Promise<{ tools: string[]; requests: ModelRequest[] }> {
  REQUESTS.length = 0;
  const agent = createAgent({ ...opts, modelPort });
  await agent.run("go");
  return {
    tools: REQUESTS[0]!.tools.map((t) => t.name),
    requests: REQUESTS,
  };
}

async function makeAgent(opts: Partial<CreateAgentOptions>) {
  REQUESTS.length = 0;
  return createAgent({ ...opts, modelPort });
}

describe("F-122 SDK lsp / db options", () => {
  it("passing lsp + db makes the five lsp_* tools and db_query visible", async () => {
    const { tools } = await captureModelRequestTools({
      lsp: stubProvider(),
      db: { opener: stubOpener(), allowWrite: false },
    });
    expect(tools).toEqual(
      expect.arrayContaining([
        "lsp_definition",
        "lsp_references",
        "lsp_rename",
        "lsp_diagnostics",
        "lsp_hover",
        "db_query",
      ]),
    );
  });

  it("db_exec is absent from the visible set when allowWrite is false", async () => {
    const { tools } = await captureModelRequestTools({
      db: { opener: stubOpener(), allowWrite: false },
    });
    expect(tools).toContain("db_query");
    expect(tools).not.toContain("db_exec");
  });

  it("allowWrite: true grants db:write and puts db_exec in the visible set", async () => {
    const { tools } = await captureModelRequestTools({
      db: { opener: stubOpener(), allowWrite: true },
    });
    expect(tools).toContain("db_query");
    expect(tools).toContain("db_exec");
  });

  it("neither option set leaves every lsp_* / db_* tool invisible", async () => {
    const { tools } = await captureModelRequestTools({});
    for (const name of [
      "lsp_definition",
      "lsp_references",
      "lsp_rename",
      "lsp_diagnostics",
      "lsp_hover",
      "db_query",
      "db_exec",
    ]) {
      expect(tools).not.toContain(name);
    }
    // Positive baseline: the absence checks above must not be able to pass on
    // a collapsed (empty) tool list.
    expect(tools).toContain("read_document");
  });

  it("dispose reaps the LSP manager and the database opener exactly once", async () => {
    const provider = stubProvider();
    const opener = stubOpener();
    const lspDispose = vi.spyOn(provider, "dispose");
    const closeAll = vi.spyOn(opener, "closeAll");

    const agent = await makeAgent({
      lsp: provider,
      db: { opener, allowWrite: true },
    });
    await agent.dispose();

    expect(lspDispose).toHaveBeenCalledTimes(1);
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("a second dispose does not re-reap the manager or the opener", async () => {
    const provider = stubProvider();
    const opener = stubOpener();
    const lspDispose = vi.spyOn(provider, "dispose");
    const closeAll = vi.spyOn(opener, "closeAll");

    const agent = await makeAgent({
      lsp: provider,
      db: { opener, allowWrite: true },
    });
    await agent.dispose();
    await agent.dispose();

    expect(lspDispose).toHaveBeenCalledTimes(1);
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("a synchronous throw from lsp.dispose still leaves every other reclamation run", async () => {
    // Deliberately not async: a misbehaving provider (or an `as any` double)
    // throws before returning a promise. Reclamation must be isolated per
    // thunk, so the opener is still closed and the failure is still reported.
    const throwingProvider = {
      async forFile() {
        return stubClient();
      },
      dispose(): Promise<void> {
        throw new Error("lsp dispose blew up");
      },
    };
    const opener = stubOpener();
    const closeAll = vi.spyOn(opener, "closeAll");

    const agent = await makeAgent({
      lsp: throwingProvider,
      db: { opener, allowWrite: true },
    });
    // The failure is reported, not swallowed: one AggregateError carrying every
    // failed reclamation, so a second failure is never dropped on the floor.
    const error: unknown = await agent.dispose().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(1);
    expect(String((error as AggregateError).errors[0])).toContain("lsp dispose blew up");

    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("a sub-agent can never see broader lsp / db tools than its parent", async () => {
    // The parent owns both capabilities; the definition declares only
    // `lsp:query`, so the intersection rule must keep db_query / db_exec out
    // of the child's real request even though the parent has them.
    const routedPort: ModelPort = {
      async *stream(req) {
        REQUESTS.push(req);
        const users = req.messages.filter((m) => m.role === "user");
        const last = users[users.length - 1];
        const lastText = typeof last?.content === "string" ? last.content : "";
        if (lastText === "child-dispatch") {
          yield* textScript("child done");
          return;
        }
        if (REQUESTS.length === 1) {
          yield* toolCallScript(
            "c1",
            "task",
            JSON.stringify({ message: "child-dispatch", subagent_type: "researcher" }),
          );
          return;
        }
        yield* textScript("parent done");
      },
    };

    REQUESTS.length = 0;
    const agent = createAgent({
      modelPort: routedPort,
      lsp: stubProvider(),
      db: { opener: stubOpener(), allowWrite: true },
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
      enableTaskTool: true,
      agentSpecs: [
        {
          id: "project:researcher",
          scope: "project",
          spec: {
            name: "researcher",
            policy: { sandbox: "workspace-write", approval: "never" },
            capabilities: ["lsp:query"],
          },
          shadowed: false,
        },
      ],
    });
    await agent.run("go");

    const childRequest = REQUESTS.find((r) => {
      const users = r.messages.filter((m) => m.role === "user");
      const last = users[users.length - 1];
      return typeof last?.content === "string" && last.content === "child-dispatch";
    });
    expect(childRequest).toBeDefined();
    const childTools = childRequest!.tools.map((t) => t.name);
    expect(childTools).toContain("lsp_definition");
    expect(childTools).not.toContain("db_query");
    expect(childTools).not.toContain("db_exec");
  });
});
