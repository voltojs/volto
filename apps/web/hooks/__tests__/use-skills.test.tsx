// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSkills } from "@/hooks/use-skills";

const ENTRIES = [
  {
    id: "user:pdf",
    name: "pdf",
    description: "read pdfs",
    scope: "user",
    filePath: "/h/.volto/skills/pdf/SKILL.md",
    baseDir: "/h/.volto/skills/pdf",
    modelInvocable: true,
    userInvocable: true,
    shadowed: false,
  },
  {
    id: "project:pdf",
    name: "pdf",
    description: "project copy",
    scope: "project",
    filePath: "/p/.volto/skills/pdf/SKILL.md",
    baseDir: "/p/.volto/skills/pdf",
    modelInvocable: true,
    userInvocable: true,
    shadowed: false,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSkills", () => {
  it("loads definitions with includeDefinitions=1 and scopes by projectId", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("includeDefinitions=1");
      expect(String(input)).toContain("projectId=proj-1");
      return new Response(JSON.stringify({ skills: ENTRIES }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useSkills("proj-1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.skills.map((s) => s.id)).toEqual(["user:pdf", "project:pdf"]);
  });

  it("surfaces a failed load instead of an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { result } = renderHook(() => useSkills(null));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.skills).toEqual([]);
  });

  it("refreshes on demand", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ skills: ENTRIES }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => useSkills(null));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const before = fetchSpy.mock.calls.length;
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(before);
  });
});
