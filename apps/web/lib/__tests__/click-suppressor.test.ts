import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickSuppressor } from "../click-suppressor";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createClickSuppressor", () => {
  it("swallows exactly one click right after a drag", () => {
    const suppressor = createClickSuppressor();
    suppressor.suppress();
    expect(suppressor.consume()).toBe(true);
    expect(suppressor.consume()).toBe(false);
  });

  it("passes clicks through when nothing was suppressed", () => {
    expect(createClickSuppressor().consume()).toBe(false);
  });

  it("expires on its own, so a drag with no trailing click does not eat the next real one", () => {
    const suppressor = createClickSuppressor();
    suppressor.suppress();
    // A keyboard drop never synthesises a row click; the flag must not
    // survive to swallow the user's next click.
    vi.advanceTimersByTime(0);
    expect(suppressor.consume()).toBe(false);
  });
});
