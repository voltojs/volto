import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // These budgets exist to catch a hang, not to assert latency. This app's
    // tests boot real HTTP servers and shell out to git — `git-endpoints`
    // alone spends 2–3.6s per case on an idle machine, so the 5s default
    // leaves almost no headroom. The whole-repo gate runs ~68 test tasks plus
    // tsc and eslint concurrently on far fewer cores, and the starved worker
    // then fails on timing rather than on behaviour.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
