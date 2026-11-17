import { describe, expect, it } from "vitest";

import { isAllowedNavigation, isShellNavigationAllowed } from "../navigation";

describe("isAllowedNavigation", () => {
  const origin = "http://127.0.0.1:3100";

  it("allows the same origin", () => {
    expect(isAllowedNavigation(origin, "http://127.0.0.1:3100/sessions")).toBe(true);
    expect(isAllowedNavigation(origin, "http://127.0.0.1:3100/")).toBe(true);
  });

  it("refuses another origin, including a different port", () => {
    expect(isAllowedNavigation(origin, "http://127.0.0.1:3101/")).toBe(false);
    expect(isAllowedNavigation(origin, "https://example.com/")).toBe(false);
    expect(isAllowedNavigation(origin, "file:///etc/passwd")).toBe(false);
  });

  it("refuses everything when no gateway is loaded", () => {
    expect(isAllowedNavigation(undefined, "http://127.0.0.1:3100/")).toBe(false);
  });

  it("allows about:blank and refuses unparseable targets", () => {
    expect(isAllowedNavigation(origin, "about:blank")).toBe(true);
    expect(isAllowedNavigation(origin, "not a url")).toBe(false);
  });
});

describe("isShellNavigationAllowed", () => {
  const file = "file:///Applications/Volto/renderer/index.html";

  it("allows the exact shell entry and about:blank", () => {
    expect(isShellNavigationAllowed(file, file)).toBe(true);
    expect(isShellNavigationAllowed(file, "about:blank")).toBe(true);
  });

  it("refuses a different local file", () => {
    expect(isShellNavigationAllowed(file, "file:///etc/passwd")).toBe(false);
  });

  it("refuses a remote page", () => {
    expect(isShellNavigationAllowed(file, "https://example.com/index.html")).toBe(false);
  });

  it("allows the dev server entry by origin and path", () => {
    const dev = "http://localhost:5173/index.html";
    expect(isShellNavigationAllowed(dev, "http://localhost:5173/index.html#/")).toBe(true);
    expect(isShellNavigationAllowed(dev, "http://localhost:5173/other.html")).toBe(false);
  });
});