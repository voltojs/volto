import { describe, it, expect } from "vitest";
import {
  renderCommand,
  parseArgs,
  findCommand,
  type SlashCommand,
} from "../commands.js";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@volto/core";

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
