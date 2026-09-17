import { describe, it, expectTypeOf } from "vitest";
import type {
  Shell,
  ShellProcessInfo,
  ShellProcessOutput,
  ShellLaunchOptions,
} from "../index.js";

describe("Shell process-management port types", () => {
  it("exposes optional process methods on Shell", () => {
    expectTypeOf<Shell["launch"]>().toEqualTypeOf<
      ((cmd: string, opts?: ShellLaunchOptions) => Promise<string>) | undefined
    >();
    expectTypeOf<Shell["readProcessOutput"]>().toEqualTypeOf<
      ((processId: string, cursor?: string) => Promise<ShellProcessOutput>) | undefined
    >();
    expectTypeOf<Shell["killProcess"]>().toEqualTypeOf<
      ((processId: string) => Promise<void>) | undefined
    >();
    expectTypeOf<Shell["listProcesses"]>().toEqualTypeOf<
      (() => ShellProcessInfo[]) | undefined
    >();
    expectTypeOf<Shell["disposeProcesses"]>().toEqualTypeOf<
      (() => Promise<void>) | undefined
    >();
  });

  it("ShellProcessOutput carries overflow facts", () => {
    expectTypeOf<ShellProcessOutput["overflowed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ShellProcessOutput["droppedBytes"]>().toEqualTypeOf<number>();
  });
});
