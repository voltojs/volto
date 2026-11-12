/**
 * Clean-install smoke fixture for the published `@volto/sdk`.
 *
 * Run by `scripts/smoke-install.mjs` from a throwaway npm project that has nothing
 * but the packed tarballs installed. Its whole job is to prove the tarball's public
 * surface works from a plain `node` process: `@volto/sdk` resolves through node's
 * own `exports` the way an outside consumer would resolve it, and a scripted
 * `ModelPort` streams two text deltas through the real agent loop.
 *
 * Only the package name is imported — never a workspace path — so a tarball that
 * ships a broken entry point fails here instead of silently passing.
 */
import { createAgent } from "@volto/sdk";

const DELTAS = ["hello", " world"];

/** A ModelPort that answers every call with the scripted deltas, then `done`. */
function createScriptedModelPort() {
  const requests = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      for (const text of DELTAS) yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

async function main() {
  const modelPort = createScriptedModelPort();
  const agent = createAgent({ modelPort });

  // Installed tarballs must resolve their own module graph: no workspace path may leak.
  const loaded = import.meta.resolve("@volto/sdk");
  if (loaded.includes("/.worktrees/") || loaded.includes("/packages/")) {
    throw new Error(`@volto/sdk resolved outside node_modules: ${loaded}`);
  }

  const received = [];
  for await (const event of agent.stream("say hello")) {
    if (event.type === "text_delta") received.push(event.data.text);
  }

  if (JSON.stringify(received) !== JSON.stringify(DELTAS)) {
    throw new Error(`expected deltas ${JSON.stringify(DELTAS)}, received ${JSON.stringify(received)}`);
  }
  console.log(`SMOKE OK: agent streamed ${received.length} deltas`);
}

main().catch((error) => {
  console.error(`SMOKE FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});