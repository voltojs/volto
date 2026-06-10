import { describe, it, expect } from "vitest";
import {
  decideSelfCorrect,
  createSchemaValidator,
  DEFAULT_MAX_SELF_CORRECTIONS,
} from "../self-correct.js";
import type { ValidationResult } from "../self-correct.js";

describe("decideSelfCorrect", () => {
  const passedValidation: ValidationResult = {
    passed: true,
    failures: [],
    validatorName: "test",
  };

  const failedValidation: ValidationResult = {
    passed: false,
    failures: ["Missing field 'name'"],
    validatorName: "schema",
  };

  it("no correction when validation passes", () => {
    const decision = decideSelfCorrect(passedValidation, 0);
    expect(decision.shouldCorrect).toBe(false);
    expect(decision.remainingBudget).toBe(DEFAULT_MAX_SELF_CORRECTIONS);
  });

  it("triggers correction when validation fails and budget available", () => {
    const decision = decideSelfCorrect(failedValidation, 0);
    expect(decision.shouldCorrect).toBe(true);
    expect(decision.remainingBudget).toBe(DEFAULT_MAX_SELF_CORRECTIONS - 1);
    expect(decision.repairPrompt).toContain("SELF-CORRECT");
    expect(decision.repairPrompt).toContain("Missing field");
  });

  it("generates correct remaining budget countdown", () => {
    const d1 = decideSelfCorrect(failedValidation, 0);
    expect(d1.remainingBudget).toBe(2); // 3 - 0 - 1 = 2

    const d2 = decideSelfCorrect(failedValidation, 1);
    expect(d2.remainingBudget).toBe(1); // 3 - 1 - 1 = 1

    const d3 = decideSelfCorrect(failedValidation, 2);
    expect(d3.remainingBudget).toBe(0); // 3 - 2 - 1 = 0
    expect(d3.shouldCorrect).toBe(true); // still triggers, budget becomes 0
  });

  it("budget exhausted → no correction, forced termination message", () => {
    const decision = decideSelfCorrect(failedValidation, 3); // 3 = max
    expect(decision.shouldCorrect).toBe(false);
    expect(decision.remainingBudget).toBe(0);
    expect(decision.repairPrompt).toContain("BUDGET EXHAUSTED");
  });

  it("respects custom max corrections", () => {
    const decision = decideSelfCorrect(failedValidation, 1, 2); // max=2, count=1
    expect(decision.shouldCorrect).toBe(true);
    expect(decision.remainingBudget).toBe(0);
  });

  it("deterministic — same input always same output", () => {
    const d1 = decideSelfCorrect(failedValidation, 1);
    const d2 = decideSelfCorrect(failedValidation, 1);
    expect(d1).toEqual(d2);
  });
});

describe("createSchemaValidator", () => {
  it("passes for valid JSON", () => {
    const validator = createSchemaValidator();
    const result = validator.validate("test", '{"key": "value"}');
    expect(result.passed).toBe(true);
  });

  it("fails for invalid JSON", () => {
    const validator = createSchemaValidator();
    const result = validator.validate("test", "not json");
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("Invalid JSON");
  });

  it("fails when expected keys are missing", () => {
    const validator = createSchemaValidator(["name", "age"]);
    const result = validator.validate("test", '{"name": "Alice"}');
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("age");
  });

  it("passes when all expected keys present", () => {
    const validator = createSchemaValidator(["name", "age"]);
    const result = validator.validate("test", '{"name": "Alice", "age": 30}');
    expect(result.passed).toBe(true);
  });
});
