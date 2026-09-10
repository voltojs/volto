import { describe, it, expect } from "vitest";
import { classifyRunnerFailure, DENIAL_SIGNATURES } from "../sandbox-enforcement.js";

describe("classifyRunnerFailure", () => {
  it("identifies the sandbox-exec failure that hid the -p defect for three review rounds", () => {
    // Verbatim shape of what `sandbox-exec -p <path>` produced: the runner
    // never executed the command, but the old code reported it as an
    // ordinary non-zero command exit and every test stayed green.
    const stderr = "sandbox-exec: line 1: unbound variable: /var/folders/x/profile.sb";
    expect(classifyRunnerFailure("seatbelt", 1, stderr)).toContain("unbound variable");
  });

  it("does not call a genuine denial a runner failure", () => {
    // Confinement worked and blocked the write. This must stay null, or a
    // working sandbox gets reported as broken infrastructure.
    const stderr = "touch: /etc/passwd: Operation not permitted";
    expect(classifyRunnerFailure("seatbelt", 1, stderr)).toBeNull();
  });

  it("does not treat a plain failing command as a runner failure", () => {
    expect(classifyRunnerFailure("seatbelt", 2, "grep: no such file")).toBeNull();
  });

  it("ignores informational runner lines that are not failures", () => {
    const stderr = "bwrap: Creating new namespace";
    expect(classifyRunnerFailure("bubblewrap", 1, stderr)).toBeNull();
  });

  it("identifies a bwrap setup failure", () => {
    const stderr = "bwrap: Can't create file at /nonexistent: No such file or directory";
    expect(classifyRunnerFailure("bubblewrap", 1, stderr)).toContain("Can't create file");
  });

  it("never reports a runner failure on exit code 0", () => {
    expect(classifyRunnerFailure("seatbelt", 0, "sandbox-exec: unbound variable")).toBeNull();
  });

  it("keeps each backend's denial dialect separate", () => {
    // The union would claim denials a given backend never produces.
    expect(DENIAL_SIGNATURES.seatbelt).toContain("operation not permitted");
    expect(DENIAL_SIGNATURES.seatbelt).not.toContain("read-only file system");
    expect(DENIAL_SIGNATURES.bubblewrap).toContain("read-only file system");
  });
});
