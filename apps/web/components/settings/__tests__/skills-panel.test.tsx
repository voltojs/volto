import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SkillsPanel } from "../SkillsPanel";

const SKILLS = [
  {
    id: "user:pdf",
    name: "pdf",
    description: "reads pdfs",
    scope: "user",
    filePath: "/h/.volto/skills/pdf/SKILL.md",
    baseDir: "/h/.volto/skills/pdf",
    modelInvocable: false,
    userInvocable: true,
    shadowed: true,
  },
  {
    id: "project:pdf",
    name: "pdf",
    description: "project pdfs",
    scope: "project",
    filePath: "/p/.volto/skills/pdf/SKILL.md",
    baseDir: "/p/.volto/skills/pdf",
    modelInvocable: true,
    userInvocable: true,
    shadowed: false,
  },
  {
    id: "project:release",
    name: "release",
    description: "release notes",
    scope: "project",
    filePath: "/p/.volto/skills/release/SKILL.md",
    baseDir: "/p/.volto/skills/release",
    modelInvocable: true,
    userInvocable: true,
    shadowed: false,
  },
];

function stub(skills = SKILLS, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(status === 200 ? JSON.stringify({ skills }) : "boom", { status }),
    ),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SkillsPanel", () => {
  it("groups user-level and project-level entries with counts", async () => {
    stub();
    render(<SkillsPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText("project pdfs")).toBeInTheDocument());
    expect(screen.getByText("用户级")).toBeInTheDocument();
    expect(screen.getByText("项目级")).toBeInTheDocument();
    expect(screen.getByText("1 个")).toBeInTheDocument();
    expect(screen.getByText("2 个")).toBeInTheDocument();
  });

  it("marks a shadowed entry and says it has no effect", async () => {
    stub();
    render(<SkillsPanel projectId="p1" />);
    await waitFor(() =>
      expect(screen.getByText("pdf（shadowed）")).toBeInTheDocument(),
    );
    expect(screen.getByText(/被.*覆盖|不生效/)).toBeInTheDocument();
  });

  it("shows the invocation badge for a manual-only skill", async () => {
    stub();
    render(<SkillsPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText("仅手动调用")).toBeInTheDocument());
  });

  it("labels the project group as the gateway default dir without a workspace", async () => {
    stub();
    render(<SkillsPanel projectId={null} />);
    await waitFor(() =>
      expect(screen.getByText(/网关默认目录/)).toBeInTheDocument(),
    );
  });

  it("renders a directory hint for an empty group", async () => {
    stub([]);
    render(<SkillsPanel projectId={null} />);
    await waitFor(() =>
      expect(screen.getAllByText(/每个技能一个子目录/).length).toBe(2),
    );
  });

  it("shows a retry affordance when the gateway fails", async () => {
    stub(undefined, 500);
    render(<SkillsPanel projectId={null} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument(),
    );
  });
});
