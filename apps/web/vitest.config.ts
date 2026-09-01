import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: ["__tests__/**/*.test.ts"],
  },
});
