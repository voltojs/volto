import { describe, it, expect } from "vitest";
import {
  renderCommand,
  parseArgs,
  findCommand,
  type SlashCommand,
} from "../commands.js";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@volto/core";
import type { SkillRegistry } from "@volto/core";

// ──────────────────────────────────────────────
// parseArgs
// ──────────────────────────────────────────────

describe("parseArgs", () => {
  it("empty string → empty args", () => {
    expect(parseArgs("")).toEqual({});
  });

  it("positional args", () => {
    expect(parseArgs("hello world")).toEqual({ "0": "hello", "1": "world" });
  });

  it("key=value args", () => {
    expect(parseArgs("name=alice count=5")).toEqual({ name: "alice", count: "5" });
  });

  it("quoted values", () => {
    expect(parseArgs('msg="hello world"')).toEqual({ msg: "hello world" });
  });

  it("mixed positional and key=value", () => {
    expect(parseArgs("first name=alice")).toEqual({ "0": "first", name: "alice" });
  });

  it("snapshot", () => {
    expect(parseArgs('target=/tmp/file msg="multi word" flag=true')).toMatchInlineSnapshot(`
      {
        "flag": "true",
        "msg": "multi word",
        "target": "/tmp/file",
      }
    `);
  });
});

// ──────────────────────────────────────────────
// renderCommand
// ──────────────────────────────────────────────

describe("renderCommand", () => {
  const commands: SlashCommand[] = [
    { name: "greet", template: "Hello {{name}}, welcome to {{place}}!" },
    { name: "echo", template: "{{msg}}" },
    { name: "multi", template: "a={{a}} b={{b}}" },
  ];

  it("renders template with named args", () => {
    const result = renderCommand(commands, "/greet name=Alice place=Wonderland");
    expect(result).toBe("Hello Alice, welcome to Wonderland!");
  });

  it("unknown command → normalized prompt (no throw)", () => {
    const result = renderCommand(commands, "/nonexistent hello");
    expect(result).toContain("Unknown command");
    expect(result).toContain("/nonexistent");
  });

  it("non-command input passes through", () => {
    const result = renderCommand(commands, "just a regular message");
    expect(result).toBe("just a regular message");
  });

  it("unmatched placeholders are removed", () => {
    const result = renderCommand(commands, "/greet name=Alice");
    expect(result).toBe("Hello Alice, welcome to !");
  });

  it("command with no args renders template as-is", () => {
    const cmds: SlashCommand[] = [{ name: "ping", template: "pong" }];
    const result = renderCommand(cmds, "/ping");
    expect(result).toBe("pong");
  });

  it("snapshot: full render", () => {
    expect(renderCommand(commands, "/multi x=1 y=2")).toMatchInlineSnapshot(`"a= b="`);
  });
});

describe("findCommand", () => {
  const commands: SlashCommand[] = [
    { name: "greet", template: "Hello {{name}}!" },
  ];

  it("finds existing command", () => {
    expect(findCommand(commands, "greet")).toBeDefined();
  });

  it("returns undefined for unknown", () => {
    expect(findCommand(commands, "nope")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// createAgent integration
// ──────────────────────────────────────────────

describe("createAgent with commands (M13)", () => {
  it("slash command input is expanded to UserMessage", async () => {
    const mockModel = createMockModelPort([textScript("command worked")]);
    const agent = createAgent({
      modelPort: mockModel,
      commands: [
        { name: "hello", template: "Say hello to the user" },
      ],
    });

    const state = await agent.run("/hello");
    expect(state.status).toBe("done");
    // The user message should be the rendered template, not "/hello"
    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect((userMsg as { content: string }).content).toBe("Say hello to the user");
  });

  it("unknown command produces normalized prompt", async () => {
    const mockModel = createMockModelPort([textScript("ok")]);
    const agent = createAgent({
      modelPort: mockModel,
      commands: [{ name: "greet", template: "Hello!" }],
    });

    const state = await agent.run("/unknown args");
    expect(state.status).toBe("done");
    const userMsg = state.messages.find((m) => m.role === "user");
    expect((userMsg as { content: string }).content).toContain("Unknown command");
  });

  it("non-command input passes through normally", async () => {
    const mockModel = createMockModelPort([textScript("ok")]);
    const agent = createAgent({
      modelPort: mockModel,
      commands: [{ name: "greet", template: "Hello!" }],
    });

    const state = await agent.run("just chatting");
    expect(state.status).toBe("done");
    const userMsg = state.messages.find((m) => m.role === "user");
    expect((userMsg as { content: string }).content).toBe("just chatting");
  });

  it("backward compat — no commands, works as before", async () => {
    const mockModel = createMockModelPort([textScript("no commands")]);
    const agent = createAgent({ modelPort: mockModel });
    const state = await agent.run("/anything");
    expect(state.status).toBe("done");
  });
});

// ──────────────────────────────────────────────
// Resolution order through the public run()/stream() entry points
// (Plan 018 Task 10 ruling): a registered command wins first, then a
// user-invocable skill, then today's unchanged unknown-command fallback.
// Commands and skills are independent namespaces throughout.
// ──────────────────────────────────────────────

describe("createAgent — /name resolution order (commands vs. skills)", () => {
  function userMessageContent(
    state: Awaited<ReturnType<ReturnType<typeof createAgent>["run"]>>,
  ): unknown {
    // findLast, not find — an agent instance carries conversation history
    // across turns, so a test that calls run() more than once on the same
    // instance must read the most recent user message, not the first.
    const userMsg = [...state.messages].reverse().find((m) => m.role === "user");
    return (userMsg as { content: unknown } | undefined)?.content;
  }

  it("a registered command wins over a same-named skill", async () => {
    const registry: SkillRegistry = {
      list: async () => [
        { name: "x", description: "a skill also named x", invocation: { modelInvocable: true, userInvocable: true } },
      ],
      load: async (name) =>
        name === "x" ? { body: "SKILL BODY for x", baseDir: "/skills/x" } : undefined,
    };
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "x", template: "COMMAND RENDERED" }],
      skillRegistry: registry,
    });

    const state = await agent.run("/x");

    // The command wins: content is the rendered template string, not the
    // array shape expandSkillInvocation would have produced, and the skill
    // body never appears anywhere in the recorded user message.
    expect(userMessageContent(state)).toBe("COMMAND RENDERED");
    expect(JSON.stringify(state.messages)).not.toContain("SKILL BODY for x");
  });

  it("falls back to a user-invocable skill when no command matches", async () => {
    const registry: SkillRegistry = {
      list: async () => [
        { name: "y", description: "d", invocation: { modelInvocable: false, userInvocable: true } },
      ],
      load: async (name) =>
        name === "y" ? { body: "Y SKILL BODY", baseDir: "/skills/y" } : undefined,
    };
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "other", template: "unused" }],
      skillRegistry: registry,
    });

    const state = await agent.run("/y do the thing");

    const content = userMessageContent(state) as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    // The user's own text stays verbatim as the FIRST block.
    expect(content[0]).toEqual({ type: "text", text: "/y do the thing" });
    // The skill's instructions are appended AFTER it.
    expect(content[1]?.text).toContain("Y SKILL BODY");
    expect(content[1]?.text).toContain('The user invoked the skill "y"');
  });

  it("neither a command nor a skill matches — unchanged unknown-command text", async () => {
    const registry: SkillRegistry = {
      list: async () => [
        { name: "y", description: "d", invocation: { modelInvocable: false, userInvocable: true } },
      ],
      load: async () => undefined,
    };
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "other", template: "unused" }],
      skillRegistry: registry,
    });

    const state = await agent.run("/nope args");

    expect(userMessageContent(state)).toBe(
      "Unknown command: /nope. Available commands: /other.",
    );
  });

  it("no skillRegistry configured — identical to today for all three cases above", async () => {
    // Case 1: a name that (in the other tests) matches a command.
    const agentWithCommand = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "x", template: "COMMAND RENDERED" }],
    });
    expect(userMessageContent(await agentWithCommand.run("/x"))).toBe("COMMAND RENDERED");

    // Case 2: a name that (with a registry) would resolve to a skill —
    // without a registry it must fall through to the unknown-command text,
    // exactly as it did before this task.
    const agentNoRegistry = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "other", template: "unused" }],
    });
    expect(userMessageContent(await agentNoRegistry.run("/y do the thing"))).toBe(
      "Unknown command: /y. Available commands: /other.",
    );

    // Case 3: neither a command nor (absent) a skill matches.
    expect(userMessageContent(await agentNoRegistry.run("/nope args"))).toBe(
      "Unknown command: /nope. Available commands: /other.",
    );
  });

  it("Finding I-2: a user-invocable, model-invocation-disabled skill preserves the user's text instead of 'Unknown command'", async () => {
    // Mirrors a real `user-invocable: true` + `disable-model-invocation: true`
    // SKILL.md: registry.list() reports it, but registry.load() — which
    // filters on modelInvocable host-side — always misses it. Before the
    // fix, expandSkillInvocation returned the untouched input by reference,
    // resolveInput read that as "nothing was expanded", and fell through to
    // renderCommand — replacing the whole user sentence with
    // "Unknown command: /manual-only. Available commands: /other.".
    const registry: SkillRegistry = {
      list: async () => [
        { name: "manual-only", description: "d", invocation: { modelInvocable: false, userInvocable: true } },
      ],
      load: async () => undefined,
    };
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "other", template: "unused" }],
      skillRegistry: registry,
    });

    const state = await agent.run("/manual-only please do X");

    expect(userMessageContent(state)).toBe("/manual-only please do X");
    expect(JSON.stringify(state.messages)).not.toContain("Unknown command");
  });

  it("Finding I-2: registry.load() throwing preserves the user's text instead of 'Unknown command'", async () => {
    const registry: SkillRegistry = {
      list: async () => [
        { name: "flaky", description: "d", invocation: { modelInvocable: true, userInvocable: true } },
      ],
      load: async () => {
        throw new Error("disk exploded");
      },
    };
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("ok")]),
      commands: [{ name: "other", template: "unused" }],
      skillRegistry: registry,
    });

    const state = await agent.run("/flaky please do X");

    expect(userMessageContent(state)).toBe("/flaky please do X");
    expect(JSON.stringify(state.messages)).not.toContain("Unknown command");
  });
});
