import { describe, it, expect } from "vitest";
import { parseSkillFile } from "../skills/frontmatter.js";

const wrap = (fm: string, body = "Body text.") => `---\n${fm}\n---\n${body}`;

describe("parseSkillFile", () => {
  it("parses plain scalars", () => {
    const parsed = parseSkillFile(wrap("name: demo\ndescription: A demo skill"));
    expect(parsed?.name).toBe("demo");
    expect(parsed?.description).toBe("A demo skill");
    expect(parsed?.body).toBe("Body text.");
  });

  it("strips matching quotes", () => {
    expect(parseSkillFile(wrap(`name: demo\ndescription: "A: colon"`))?.description).toBe(
      "A: colon",
    );
    expect(parseSkillFile(wrap("name: demo\ndescription: 'single'"))?.description).toBe("single");
  });

  it("folds a `>-` block into one line", () => {
    const parsed = parseSkillFile(
      wrap("name: demo\ndescription: >-\n  first line\n  second line"),
    );
    expect(parsed?.description).toBe("first line second line");
  });

  it("keeps newlines in a `|` literal block", () => {
    const parsed = parseSkillFile(wrap("name: demo\ndescription: |\n  line one\n  line two"));
    expect(parsed?.description).toBe("line one\nline two");
  });

  it("appends an unmarked indented continuation to the previous key", () => {
    const parsed = parseSkillFile(wrap("name: demo\ndescription: starts here\n  and continues"));
    expect(parsed?.description).toBe("starts here and continues");
  });

  it("skips comment lines", () => {
    const parsed = parseSkillFile(wrap("# a comment\nname: demo\ndescription: d"));
    expect(parsed?.name).toBe("demo");
  });

  it("normalises CRLF before parsing", () => {
    const parsed = parseSkillFile("---\r\nname: demo\r\ndescription: d\r\n---\r\nBody.");
    expect(parsed?.description).toBe("d");
    expect(parsed?.body).toBe("Body.");
  });

  it("reads the dsh-compatible invocation flags", () => {
    const off = parseSkillFile(
      wrap("name: d\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false"),
    );
    expect(off?.invocation).toEqual({ modelInvocable: false, userInvocable: false });
    const on = parseSkillFile(wrap("name: d\ndescription: d"));
    expect(on?.invocation).toEqual({ modelInvocable: true, userInvocable: true });
  });

  it("rejects files without frontmatter or without name/description", () => {
    expect(parseSkillFile("no frontmatter")).toBeUndefined();
    expect(parseSkillFile(wrap("name: only"))).toBeUndefined();
  });
});
