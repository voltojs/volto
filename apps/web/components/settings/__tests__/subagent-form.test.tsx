import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentForm } from "../SubagentForm";
import type { RoutingTier } from "@/lib/routing-tiers-api";

// jsdom does not implement the pointer-capture / scroll APIs Base UI's
// Select uses internally; stub them so the popup can open in tests.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const TOOLS = [
  { name: "read_file", description: "read a file" },
  { name: "bash", description: "run a command" },
];

const TIERS: RoutingTier[] = [
  {
    id: "premium",
    label: "最强",
    description: "复杂任务",
    target: { providerId: "v1", modelId: "m2" },
  },
  {
    id: "economy",
    label: "省成本",
    description: "日常任务",
    target: { providerId: "v1", modelId: "m1" },
  },
];

const MODEL_LABEL = "model（可选）";

describe("SubagentForm", () => {
  it("offers a scope choice when creating", () => {
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/作用范围/)).toBeInTheDocument();
    expect(screen.getByText(/项目级/)).toBeInTheDocument();
    expect(screen.getByText(/用户级/)).toBeInTheDocument();
  });

  it("lists every tool from the catalogue as a choice", () => {
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "read_file" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "bash" })).toBeInTheDocument();
  });

  it("prefills every field when editing", () => {
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        tiers={TIERS}
        entry={{
          id: "project:x", name: "x", scope: "project", readOnly: false, shadowed: false,
          spec: { name: "x", description: "desc", tools: ["read_file"], model: "economy", systemPrompt: "body" },
        } as never}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("x")).toBeInTheDocument();
    expect(screen.getByDisplayValue("desc")).toBeInTheDocument();
    expect(screen.getByDisplayValue("body")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "read_file" })).toBeChecked();
    // spec.model holds a routing tier id; the dropdown echoes its label.
    expect(screen.getByRole("combobox", { name: MODEL_LABEL })).toHaveTextContent("省成本");
    // Scope cannot change on edit: that would mean moving the file.
    expect(screen.queryByLabelText(/作用范围/)).not.toBeInTheDocument();
  });

  it("renders the model field as a dropdown of the inherit option and every tier label", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("combobox", { name: MODEL_LABEL }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "继承主对话",
      "最强",
      "省成本",
    ]);
  });

  it("submits the selected tier id as spec.model", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText("名称"), "x");
    await user.click(screen.getByRole("combobox", { name: MODEL_LABEL }));
    await user.click(await screen.findByRole("option", { name: "最强" }));
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].spec.model).toBe("premium");
  });

  it("submits an undefined spec.model when inheriting the parent model", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText("名称"), "x");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // The inherit sentinel is UI-only: the wire value is "no model field".
    expect(onSubmit.mock.calls[0]![0].spec.model).toBeUndefined();
  });

  it("drops spec.model when the selection goes back to inherit", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        tiers={TIERS}
        entry={{
          id: "project:x", name: "x", scope: "project", readOnly: false, shadowed: false,
          spec: { name: "x", model: "premium" },
        } as never}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: MODEL_LABEL }));
    await user.click(await screen.findByRole("option", { name: "继承主对话" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].spec.model).toBeUndefined();
  });

  it("offers only the inherit option when no tiers are configured", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentForm mode="create" tools={TOOLS} tiers={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("combobox", { name: MODEL_LABEL }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["继承主对话"]);
  });

  it("shows a model whose tier was removed as a disabled stale option", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        tiers={TIERS}
        entry={{
          id: "project:x", name: "x", scope: "project", readOnly: false, shadowed: false,
          spec: { name: "x", model: "ghost" },
        } as never}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: MODEL_LABEL });
    // The stale reference is visible in the trigger instead of silently
    // reading as "inherit".
    expect(trigger).toHaveTextContent("已失效档位:ghost");
    await user.click(trigger);
    const stale = await screen.findByRole("option", { name: "已失效档位:ghost" });
    expect(stale).toHaveAttribute("data-disabled");
    // A save the user does not retarget must not destroy the reference.
    fireEvent.submit(trigger.closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].spec.model).toBe("ghost");
  });

  it("keeps spec fields it does not edit when saving", async () => {
    const onSubmit = vi.fn();
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        tiers={TIERS}
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
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText(/项目级/));
    expect(screen.getByText(/工作区|git/)).toBeInTheDocument();
  });

  it("explains that a wider sandbox does not take effect under a stricter parent", () => {
    render(<SubagentForm mode="create" tools={TOOLS} tiers={TIERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/只能收窄|不会生效/)).toBeInTheDocument();
  });

  it("confirms deletion and shows the file path", async () => {
    const onDelete = vi.fn();
    render(
      <SubagentForm
        mode="edit"
        tools={TOOLS}
        tiers={TIERS}
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
