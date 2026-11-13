#!/usr/bin/env node
/**
 * Generate deterministic trajectory fixtures into packages/eval/trajectories/.
 *
 * Each fixture is produced by feeding a fixed input sequence through the pure
 * step() reducer and recording the FULL (state, effects) at every step via
 * TrajectoryRecorder. The reducer is a pure function, so the generated JSON
 * is byte-for-byte reproducible — the fixtures are checked into git and serve
 * as the initial regression set for `volto-eval-replay` (CI gate).
 *
 * Usage: node scripts/generate-fixtures.mjs   (after `pnpm --filter @voltojs/eval build`)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simulateTrajectory } from "@voltojs/eval";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../trajectories");

const MODEL = "fixture-model";
const MAX_TOKENS = 100;

// Tool definitions must match what replay will use (recorded in the file).
const readTool = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const writeTool = {
  name: "write_file",
  description: "Write a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  requires: ["filesystem:write"],
  riskTier: "IRREVERSIBLE",
};

/**
 * Simulate one agent session: feed `inputs` through step(), recording every
 * step's full state + full effects via the same record path `--record` uses.
 * Returns a Trajectory object.
 */
function simulate({ name, inputs, tools = [] }) {
  return simulateTrajectory(name, inputs, { model: MODEL, maxTokens: MAX_TOKENS, tools });
}

// ── Fixture definitions (fixed input sequences) ──────────────────────────

const fixtures = [
  {
    file: "simple-text.json",
    name: "simple-text: 纯对话一轮（text_delta 流式 + usage）",
    build: () =>
      simulate({
        name: "simple-text",
        inputs: [
          { type: "user_message", content: "你好，介绍一下你自己" },
          { type: "model_chunk", chunk: { type: "text_delta", text: "我是 Volto Agent 内核。" } },
          { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 9 } },
        ],
      }),
  },
  {
    file: "tool-use.json",
    name: "tool-use: 工具调用闭环（tool_use → result → 收尾）",
    build: () =>
      simulate({
        name: "tool-use",
        tools: [readTool],
        inputs: [
          { type: "user_message", content: "读取 foo.ts 的内容" },
          {
            type: "model_chunk",
            chunk: {
              type: "tool_use_delta",
              toolCallId: "call_1",
              toolCallName: "read_file",
              argumentsDelta: '{"path":',
            },
          },
          {
            type: "model_chunk",
            chunk: { type: "tool_use_delta", toolCallId: "call_1", argumentsDelta: '"foo.ts"}' },
          },
          { type: "model_done", stopReason: "tool_use" },
          {
            type: "tool_result",
            toolCallId: "call_1",
            toolName: "read_file",
            result: { modelContent: "const x = 1;" },
          },
          { type: "model_chunk", chunk: { type: "text_delta", text: "文件内容是 const x = 1。" } },
          { type: "model_done", stopReason: "end_turn" },
        ],
      }),
  },
  {
    file: "tool-error.json",
    name: "tool-error: 工具失败归一化为 error 回喂",
    build: () =>
      simulate({
        name: "tool-error",
        tools: [readTool],
        inputs: [
          { type: "user_message", content: "读取 missing.ts" },
          {
            type: "model_chunk",
            chunk: {
              type: "tool_use_delta",
              toolCallId: "call_1",
              toolCallName: "read_file",
              argumentsDelta: '{"path":"missing.ts"}',
            },
          },
          { type: "model_done", stopReason: "tool_use" },
          {
            type: "tool_result",
            toolCallId: "call_1",
            toolName: "read_file",
            result: { modelContent: "File not found: missing.ts", isError: true },
          },
          { type: "model_chunk", chunk: { type: "text_delta", text: "文件不存在，我无法读取。" } },
          { type: "model_done", stopReason: "end_turn" },
        ],
      }),
  },
  {
    file: "approval.json",
    name: "approval: HITL 审批闭环（request_approval → allow → 执行）",
    build: () =>
      simulate({
        name: "approval",
        tools: [writeTool],
        inputs: [
          { type: "user_message", content: "把 hello 写入 output.txt" },
          {
            type: "model_chunk",
            chunk: {
              type: "tool_use_delta",
              toolCallId: "call_1",
              toolCallName: "write_file",
              argumentsDelta: '{"path":"output.txt","content":"hello"}',
            },
          },
          { type: "model_done", stopReason: "tool_use" },
          { type: "request_approval", toolCallId: "call_1" },
          { type: "approval_decision", toolCallId: "call_1", decision: "allow" },
          {
            type: "tool_result",
            toolCallId: "call_1",
            toolName: "write_file",
            result: { modelContent: "wrote 5 bytes to output.txt" },
          },
          { type: "model_chunk", chunk: { type: "text_delta", text: "已写入 output.txt。" } },
          { type: "model_done", stopReason: "end_turn" },
        ],
      }),
  },
  {
    file: "steering.json",
    name: "steering: 执行工具期间用户插话（queued 到 turn 边界）",
    build: () =>
      simulate({
        name: "steering",
        tools: [readTool],
        inputs: [
          { type: "user_message", content: "读取 a.ts 和 b.ts" },
          {
            type: "model_chunk",
            chunk: {
              type: "tool_use_delta",
              toolCallId: "call_1",
              toolCallName: "read_file",
              argumentsDelta: '{"path":"a.ts"}',
            },
          },
          {
            type: "model_chunk",
            chunk: {
              type: "tool_use_delta",
              toolCallId: "call_2",
              toolCallName: "read_file",
              argumentsDelta: '{"path":"b.ts"}',
            },
          },
          { type: "model_done", stopReason: "tool_use" },
          // Steering: user interrupts while tools are executing
          { type: "user_message", content: "等等，只看 a.ts 就够了" },
          {
            type: "tool_result",
            toolCallId: "call_1",
            toolName: "read_file",
            result: { modelContent: "file a content" },
          },
          {
            type: "tool_result",
            toolCallId: "call_2",
            toolName: "read_file",
            result: { modelContent: "file b content" },
          },
          { type: "model_chunk", chunk: { type: "text_delta", text: "好的，只看 a.ts。" } },
          { type: "model_done", stopReason: "end_turn" },
        ],
      }),
  },
];

// ── Write fixtures ────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
let count = 0;
for (const fixture of fixtures) {
  const trajectory = fixture.build();
  const path = join(OUT_DIR, fixture.file);
  writeFileSync(path, `${JSON.stringify(trajectory, null, 2)}\n`);
  count++;
  console.log(`generated ${fixture.file} — ${trajectory.inputs.length} steps, ${trajectory.name}`);
}
console.log(`\n${count} trajectory fixtures written to ${OUT_DIR}`);
