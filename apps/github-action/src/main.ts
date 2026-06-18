/**
 * GitHub Action — CI host that runs agent-core as a one-shot task.
 * Reads inputs from action.yml, runs the agent, writes output.
 */

import * as fs from "node:fs";
import { createAgent } from "@volto/sdk";
import { createOpenAIModelPort } from "@volto/provider-openai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
} from "@volto/runtime-node";

function getInput(name: string): string {
  // GitHub Actions inputs are accessed via INPUT_<NAME> environment variables
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
}

function setOutput(name: string, value: string): void {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

export async function run(): Promise<void> {
  const prompt = getInput("prompt");
  const model = getInput("model") || process.env["OPENAI_MODEL"] || "gpt-4o";
  const apiKey = getInput("api_key") || process.env["OPENAI_API_KEY"] || "";
  const cwd = getInput("cwd") || process.cwd();

  if (!prompt) {
    console.error("Error: prompt input is required");
    process.exit(1);
  }

  const fsAdapter = createNodeFileSystem({ root: cwd });
  const shell = createNodeShell({ defaultCwd: cwd });
  const network = createNodeNetwork();
  const modelPort = createOpenAIModelPort({
    apiKey,
    defaultModel: model,
  });

  const agent = createAgent({
    modelPort,
    model,
    fs: fsAdapter,
    shell,
    network,
    enableTaskTool: false,
  });

  try {
    const state = await agent.run(prompt);
    const messages = state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    const responseText =
      typeof lastAssistant?.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant?.content)
          ? lastAssistant.content
              .filter((b) => b.type === "text")
              .map((b) => (b.type === "text" ? b.text : ""))
              .join("")
          : "No response";

    setOutput("response", responseText);
    setOutput("status", state.status);
    console.log(responseText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Agent error: ${message}`);
    setOutput("status", "error");
    setOutput("error", message);
    process.exit(1);
  }
}

run();
