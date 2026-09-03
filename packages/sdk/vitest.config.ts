import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: ["src/__tests__/**/*.test.ts", "src/sse/__tests__/**/*.test.ts"],
  },
});
