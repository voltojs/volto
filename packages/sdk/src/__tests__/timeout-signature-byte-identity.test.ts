import { describe, it, expect } from "vitest";
import { renderTimeoutSignature } from "@voltojs/tools-common";
import { renderNetworkTimeoutSignature } from "@voltojs/runtime-node";

// Cross-package byte-identity pin (spec D3):
// runtime-node cannot depend on @voltojs/tools-common (category dependency
// rules are one-way downward), so the network adapter renders the timeout
// signature from a byte-identical local template. This test — in a package
// that can see BOTH templates — fails if either one drifts.
describe("timeout signature byte-identity (spec D3)", () => {
  it("network-local render is byte-identical to tools-common render", () => {
    expect(renderNetworkTimeoutSignature("https://example.com/api", 30_000)).toBe(
      renderTimeoutSignature("https://example.com/api", 30_000),
    );
    expect(renderNetworkTimeoutSignature("bash", 500)).toBe(
      renderTimeoutSignature("bash", 500),
    );
  });

  it("both renders produce the full unified signature verbatim", () => {
    expect(renderNetworkTimeoutSignature("https://example.com/api", 30_000)).toBe(
      "[timeout] https://example.com/api timed out after 30000ms",
    );
    expect(renderTimeoutSignature("https://example.com/api", 30_000)).toBe(
      "[timeout] https://example.com/api timed out after 30000ms",
    );
  });
});
