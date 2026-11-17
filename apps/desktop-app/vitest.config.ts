import { defineConfig } from "vitest/config";

/**
 * Only the Electron-free modules are tested here: profile rules, the local
 * gateway supervisor, the probe and the controller. Electron itself is not
 * required, so this suite runs on plain Node.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});