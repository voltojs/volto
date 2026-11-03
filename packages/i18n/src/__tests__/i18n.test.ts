import { describe, expect, it } from "vitest";
import {
  catalog,
  DEFAULT_LOCALE,
  isLocale,
  isTextRef,
  LOCALES,
  localeFromAcceptLanguage,
  t,
} from "../index.js";
import { en } from "../messages/en.js";
import { zh } from "../messages/zh.js";

/** Flattens a catalog to its sorted key list — the equality check below works
 * on keys, not on values, so wording can change without touching this test. */
const keys = (catalog: Record<string, string>): string[] => Object.keys(catalog).sort();

describe("shared catalog", () => {
  it("ships both locales with identical key sets", () => {
    expect(keys(zh)).toEqual(keys(en));
    expect(keys(zh).length).toBeGreaterThan(0);
  });

  it("translates a known key per locale", () => {
    expect(t("zh", "server.fork.branchSuffix")).toBe("（分支）");
    expect(t("en", "server.fork.branchSuffix")).toBe(" (branch)");
  });

  it("returns the key itself when the catalog has no entry", () => {
    expect(t("en", "server.missing.key")).toBe("server.missing.key");
  });

  it("interpolates params and leaves unknown placeholders alone", () => {
    expect(t("en", "server.commands.review.description")).not.toContain("{");
    expect(t("en", "probe.params", { count: 3 })).toBe("probe.params");
  });

  it("exposes the shipped locales and narrows unknown values", () => {
    expect(LOCALES).toEqual(["zh", "en"]);
    expect(DEFAULT_LOCALE).toBe("zh");
    expect(isLocale("en")).toBe(true);
    expect(isLocale("jp")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("hands back a catalog object per locale", () => {
    expect(catalog("en")).toEqual(en);
    expect(catalog("zh")).toEqual(zh);
  });
});

describe("isTextRef", () => {
  it("accepts a key with optional params and fallback", () => {
    expect(isTextRef({ key: "server.fork.branchSuffix" })).toBe(true);
    expect(isTextRef({ key: "k", params: { n: 1, s: "x" }, fallback: "f" })).toBe(true);
  });

  it("rejects a bare string, an empty key and bad params", () => {
    expect(isTextRef("自定义")).toBe(false);
    expect(isTextRef({ key: "" })).toBe(false);
    expect(isTextRef({ key: "k", params: { n: true } })).toBe(false);
    expect(isTextRef(null)).toBe(false);
  });
});

describe("localeFromAcceptLanguage", () => {
  it("picks the first shipped language in the header", () => {
    expect(localeFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("zh-CN,zh;q=0.9")).toBe("zh");
    expect(localeFromAcceptLanguage("fr-FR,de;q=0.8,en;q=0.5")).toBe("en");
  });

  it("returns undefined when nothing shipped matches", () => {
    expect(localeFromAcceptLanguage("fr-FR")).toBeUndefined();
    expect(localeFromAcceptLanguage(undefined)).toBeUndefined();
    expect(localeFromAcceptLanguage("")).toBeUndefined();
  });
});
