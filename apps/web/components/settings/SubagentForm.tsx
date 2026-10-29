'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { AgentEntry, AgentSpec, ToolInfo } from '@/lib/agents-api';
import type { RoutingTier } from '@/lib/routing-tiers-api';

/** Discriminated payload handed to `onSubmit` — the panel maps it to API calls. */
export type SubagentFormSubmit =
  | { mode: 'create'; scope: 'project' | 'user'; spec: AgentSpec }
  | { mode: 'edit'; id: string; spec: AgentSpec };

type SubagentFormProps = {
  tools: ToolInfo[];
  /** Routing tiers offered by the model dropdown (may be empty). */
  tiers: RoutingTier[];
  onSubmit: (payload: SubagentFormSubmit) => void | Promise<void>;
  onCancel: () => void;
  /** Edit-mode only: open straight in the delete confirmation (row trash button). */
  startConfirmingDelete?: boolean;
} & (
  | { mode: 'create'; entry?: undefined; onDelete?: undefined }
  | { mode: 'edit'; entry: AgentEntry; onDelete?: () => void | Promise<void> }
);

const SANDBOX_OPTIONS = [
  { value: 'read-only', label: '只读' },
  // Labels avoid the words used by the two required notes below (工作区 /
  // 项目级): getByText(/工作区/) must resolve to exactly one element.
  { value: 'workspace-write', label: '项目内可读写' },
  { value: 'danger-full-access', label: '完全放开' },
] as const;

type SandboxMode = (typeof SANDBOX_OPTIONS)[number]['value'];

/**
 * Base UI Select rejects empty-string values, so "inherit the parent model"
 * is carried by a sentinel option value and mapped back to `model: undefined`
 * on submit — the wire semantics stay "absent field = inherit".
 */
const MODEL_INHERIT_VALUE = '__inherit__';
const MODEL_INHERIT_LABEL = '继承主对话';

type ModelOption = { value: string; label: string; disabled?: boolean };

/**
 * Create / edit form for one agent definition.
 *
 * Scope is only offered on create: changing it on an existing entry would
 * move the definition file, which is a different operation — folding it
 * into "save" would give the edit button a surprising side effect. The two
 * explanatory notes (project-level writes touch the workspace; a wider
 * sandbox is narrowed by a stricter parent) are required copy, not tips.
 */
export function SubagentForm({
  mode,
  tools,
  tiers,
  entry,
  onSubmit,
  onCancel,
  onDelete,
  startConfirmingDelete = false,
}: SubagentFormProps) {
  const spec = entry?.spec;
  const [name, setName] = useState(spec?.name ?? '');
  const [description, setDescription] = useState(spec?.description ?? '');
  const [scope, setScope] = useState<'project' | 'user'>('project');
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(spec?.tools ?? []),
  );
  // `spec.model` carries a routing tier id; the sentinel stands for inherit.
  const [model, setModel] = useState(spec?.model || MODEL_INHERIT_VALUE);
  const [sandbox, setSandbox] = useState<SandboxMode>(
    (spec?.policy?.sandbox as SandboxMode | undefined) ?? 'workspace-write',
  );
  const [systemPrompt, setSystemPrompt] = useState(spec?.systemPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Delete is two-step: the first click only reveals the confirmation, so a
  // mis-click on the small trash button never destroys a definition. The
  // panel's row trash button seeds this open; the form's 删除 button arms it.
  const [confirmingDelete, setConfirmingDelete] = useState(startConfirmingDelete);

  // A stored tier id that no longer exists in the table stays visible as an
  // explicit disabled option instead of silently reading as "inherit" — and
  // survives a save the user does not retarget, so the reference is never
  // dropped behind the user's back.
  const staleModel =
    spec?.model && !tiers.some((tier) => tier.id === spec.model)
      ? spec.model
      : undefined;
  const modelOptions: ModelOption[] = [
    { value: MODEL_INHERIT_VALUE, label: MODEL_INHERIT_LABEL },
    ...(staleModel
      ? [{ value: staleModel, label: `已失效档位:${staleModel}`, disabled: true }]
      : []),
    ...tiers.map((tier) => ({ value: tier.id, label: tier.label })),
  ];

  const toggleTool = (toolName: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  const buildSpec = (): AgentSpec => {
    const base: AgentSpec = entry
      ? // Preserve fields the form does not edit (policy.rules, caps, …)
        // so a save from this form never silently drops hand-written keys.
        { ...entry.spec }
      : { name: name.trim() };
    return {
      ...base,
      name: name.trim(),
      ...(description.trim()
        ? { description: description.trim() }
        : { description: undefined }),
      tools: [...selectedTools],
      ...(model !== MODEL_INHERIT_VALUE ? { model } : { model: undefined }),
      policy: { ...(base.policy ?? { approval: 'ask' }), sandbox },
      ...(systemPrompt.trim()
        ? { systemPrompt: systemPrompt.trim() }
        : { systemPrompt: undefined }),
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const nextSpec = buildSpec();
      if (mode === 'create') {
        await onSubmit({ mode: 'create', scope, spec: nextSpec });
      } else {
        await onSubmit({ mode: 'edit', id: entry.id, spec: nextSpec });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} data-agent-form="">
      <FieldGroup>
        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-name">名称</FieldLabel>
          <Input
            id="agent-name"
            className="h-8"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="唯一名称，如 searcher"
            required
          />
        </Field>

        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-description">描述</FieldLabel>
          <Textarea
            id="agent-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话说明用途（进入 task 工具描述）"
            rows={2}
          />
        </Field>

        {mode === 'create' && (
          <FieldSet aria-label="作用范围">
            <FieldLegend>作用范围</FieldLegend>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as 'project' | 'user')}
            >
              <Field orientation="horizontal">
                <RadioGroupItem value="project" id="agent-scope-project" />
                {/* Base UI radios/checkboxes resolve their accessible name from
                    a `<label id="{id}-label">` sibling reference. */}
                <FieldLabel
                  htmlFor="agent-scope-project"
                  id="agent-scope-project-label"
                >
                  项目级
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem value="user" id="agent-scope-user" />
                <FieldLabel htmlFor="agent-scope-user" id="agent-scope-user-label">
                  用户级
                </FieldLabel>
              </Field>
            </RadioGroup>
            {scope === 'project' && (
              // Required copy (F-028): a project-level write lands in
              // .volto/agents inside the repo, so the workspace gains a git
              // change the user did not make in their editor. Wording avoids
              // 「项目级」 so the scope radio labels stay unique matches.
              <FieldDescription className="text-amber-600 dark:text-amber-500">
                写入 .volto/agents/ 的定义保存后会在工作区产生 git 变更。
              </FieldDescription>
            )}
          </FieldSet>
        )}

        <FieldSet aria-label="工具">
          <FieldLegend>工具</FieldLegend>
          {tools.length === 0 && (
            <FieldDescription>
              工具目录为空，暂无可勾选的工具。
            </FieldDescription>
          )}
          {/* Compact grid rather than a vertical stack: the catalogue has a
              dozen-plus tools and a one-per-row list pushes the rest of the
              form below the fold. Fields fill their cell so the checkbox and
              label stay one click target. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {tools.map((tool) => (
              <Field key={tool.name} orientation="horizontal" className="w-auto">
                <Checkbox
                  id={`agent-tool-${tool.name}`}
                  checked={selectedTools.has(tool.name)}
                  onCheckedChange={() => toggleTool(tool.name)}
                />
                <FieldLabel
                  htmlFor={`agent-tool-${tool.name}`}
                  id={`agent-tool-${tool.name}-label`}
                  className="text-sm font-normal"
                >
                  {tool.name}
                </FieldLabel>
              </Field>
            ))}
          </div>
        </FieldSet>

        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-model">model（可选）</FieldLabel>
          <Select
            items={modelOptions}
            value={model}
            onValueChange={(value) => setModel(String(value))}
          >
            <SelectTrigger id="agent-model" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {modelOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-sandbox">sandbox</FieldLabel>
          <Select
            items={SANDBOX_OPTIONS}
            value={sandbox}
            onValueChange={(value) => setSandbox(value as SandboxMode)}
          >
            <SelectTrigger id="agent-sandbox" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {SANDBOX_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* Required copy (F-029): a child can only narrow its parent's
              sandbox, so a wider choice here reads as broken rather than
              narrowed unless the form says so up front. */}
          <FieldDescription>
            sandbox 只能收窄：子代理的权限比父会话更宽时不会生效。
          </FieldDescription>
        </Field>

        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-system-prompt">systemPrompt</FieldLabel>
          <Textarea
            id="agent-system-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="子代理的系统提示词"
            rows={4}
          />
        </Field>

        {error && <FieldError>{error}</FieldError>}

        {confirmingDelete && entry ? (
          <div
            className="space-y-2 rounded-md border border-destructive/40 p-2"
            data-delete-confirm=""
          >
            {/* The file path is the concrete thing being removed — an abstract
                "are you sure?" does not tell the user what disappears. Wording
                avoids 「确认删除」 so the confirm button stays a unique match. */}
            <p className="text-sm">
              删除「{entry.name}」将移除文件{' '}
              <code className="font-mono text-xs">
                {entry.filePath ?? entry.id}
              </code>
              ，此操作不可撤销。
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void onDelete?.()}
              >
                确认删除
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving ? '保存中…' : mode === 'create' ? '创建' : '保存'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              取消
            </Button>
            {mode === 'edit' && onDelete && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                删除
              </Button>
            )}
          </div>
        )}
      </FieldGroup>
    </form>
  );
}
