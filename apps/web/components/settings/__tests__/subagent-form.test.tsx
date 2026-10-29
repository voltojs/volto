import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SubagentForm } from "../SubagentForm";

const TOOLS = [
  { name: "read_file", description: "read a file" },
  { name: "bash", description: "run a command" },
];

describe("SubagentForm", () => {
  it("offers a scope choice when creating", () => {
    render(<SubagentForm mode="create" tools={TOOLS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/作用范围/)).toBeInTheDocument();
    expect(screen.getByText(/项目级/)).toBeInTheDocument();
    expect(screen.getByText(/用户级/)).toBeInTheDocument();
  });

  it("lists every tool from the catalogue as a choice", () => {
    render(<SubagentForm mode="create" tools={TOOLS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "read_file" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "bash" })).toBeInTheDocument();
  });

  it("prefills every field when editing", () => {
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        entry={{
          id: "project:x", name: "x", scope: "project", readOnly: false, shadowed: false,
          spec: { name: "x", description: "desc", tools: ["read_file"], systemPrompt: "body" },
        } as never}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("x")).toBeInTheDocument();
    expect(screen.getByDisplayValue("desc")).toBeInTheDocument();
    expect(screen.getByDisplayValue("body")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "read_file" })).toBeChecked();
    // Scope cannot change on edit: that would mean moving the file.
    expect(screen.queryByLabelText(/作用范围/)).not.toBeInTheDocument();
  });

  it("keeps spec fields it does not edit when saving", async () => {
    const onSubmit = vi.fn();
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        entry={{
          id: "project:x", name: "x", scope: "project", readOnly: false, shadowed: false,
          spec: {
            name: "x",
            maxIterations: 7,
            responseFormat: { type: "json", schema: { type: "object" } },
          },
        } as never}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.submit(screen.getByDisplayValue("x").closest("form")!);
    // The server replaces the file's owned frontmatter wholesale, so a field
    // this form drops is a field the user loses.
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].spec).toMatchObject({
      maxIterations: 7,
      responseFormat: { type: "json", schema: { type: "object" } },
    });
  });

  it("warns that a project-level definition changes the workspace", () => {
    render(<SubagentForm mode="create" tools={TOOLS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText(/项目级/));
    expect(screen.getByText(/工作区|git/)).toBeInTheDocument();
  });

  it("explains that a wider sandbox does not take effect under a stricter parent", () => {
    render(<SubagentForm mode="create" tools={TOOLS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/只能收窄|不会生效/)).toBeInTheDocument();
  });

  it("confirms deletion and shows the file path", async () => {
    const onDelete = vi.fn();
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        entry={{ id: "project:x", name: "x", scope: "project", readOnly: false, shadowed: false, filePath: "/p/.volto/agents/x.md", spec: { name: "x" } } as never}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByText(/删除/));
    await waitFor(() => expect(screen.getByText("/p/.volto/agents/x.md")).toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();   // not until confirmed
    fireEvent.click(screen.getByText(/确认删除/));
    expect(onDelete).toHaveBeenCalled();
  });
});
