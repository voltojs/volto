import { describe, it, expect } from "vitest";
import { VERSION } from "../index.js";

describe("@voltojs/core", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
