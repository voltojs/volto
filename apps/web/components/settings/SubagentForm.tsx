'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AgentEntry, AgentSpec, ToolInfo } from '@/lib/agents-api';

/** Discriminated payload handed to `onSubmit` — the panel maps it to API calls. */
export type SubagentFormSubmit =
  | { mode: 'create'; scope: 'project' | 'user'; spec: AgentSpec }
  | { mode: 'edit'; id: string; spec: AgentSpec };

type SubagentFormProps = {
  tools: ToolInfo[];
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
  const [model, setModel] = useState(spec?.model ?? '');
  const [sandbox, setSandbox] = useState<SandboxMode>(
    (spec?.policy?.sandbox as SandboxMode | undefined) ?? 'workspace-write',
  );
  const [systemPrompt, setSystemPrompt] = useState(spec?.systemPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Delete is two-step: the first click only reveals the confirmation, so a
  // mis-click on the small trash button never destroys a definition. The
  // panel's row trash button seeds this open; the form's own 删除 button arms it.
  const [confirmingDelete, setConfirmingDelete] = useState(startConfirmingDelete);

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
      ...(model.trim() ? { model: model.trim() } : { model: undefined }),
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
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3" data-agent-form="">
      <label className="space-y-1">
        <span className="text-muted-foreground text-[11px]">名称</span>
        <Input
          className="h-8"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="唯一名称，如 searcher"
          required
        />
      </label>

      <label className="space-y-1">
        <span className="text-muted-foreground text-[11px]">描述</span>
        <Input
          className="h-8"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明用途（进入 task 工具描述）"
        />
      </label>

      {mode === 'create' && (
        <fieldset aria-label="作用范围" className="space-y-1">
          <legend className="text-muted-foreground text-[11px]">作用范围</legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="agent-scope"
                value="project"
                checked={scope === 'project'}
                onChange={() => setScope('project')}
              />
              项目级
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="agent-scope"
                value="user"
                checked={scope === 'user'}
                onChange={() => setScope('user')}
              />
              用户级
            </label>
          </div>
          {scope === 'project' && (
            // Required copy (F-028): a project-level write lands in
            // .volto/agents inside the repo, so the workspace gains a git
            // change the user did not make in their editor. Wording avoids
            // 「项目级」 so the scope radio labels stay unique matches.
            <p className="text-xs text-amber-600 dark:text-amber-500">
              写入 .volto/agents/ 的定义保存后会在工作区产生 git 变更。
            </p>
          )}
        </fieldset>
      )}

      <fieldset className="space-y-1">
        <legend className="text-muted-foreground text-[11px]">工具</legend>
        {tools.length === 0 && (
          <p className="text-muted-foreground text-xs">工具目录为空，暂无可勾选的工具。</p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {tools.map((tool) => (
            <label
              key={tool.name}
              className="flex items-center gap-1.5 text-sm"
              title={tool.description}
            >
              <input
                type="checkbox"
                checked={selectedTools.has(tool.name)}
                onChange={() => toggleTool(tool.name)}
              />
              {tool.name}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="space-y-1">
        <span className="text-muted-foreground text-[11px]">model（可选）</span>
        <Input
          className="h-8 font-mono text-xs"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="留空继承主会话模型"
        />
      </label>

      <label className="space-y-1">
        <span className="text-muted-foreground text-[11px]">sandbox</span>
        <select
          className="border-input h-8 w-full rounded-lg border bg-transparent px-2 text-sm"
          value={sandbox}
          onChange={(e) => setSandbox(e.target.value as SandboxMode)}
        >
          {SANDBOX_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {/* Required copy (F-029): a child can only narrow its parent's
            sandbox, so a wider choice here reads as broken rather than
            narrowed unless the form says so up front. */}
        <p className="text-muted-foreground text-xs">
          sandbox 只能收窄：子代理的权限比父会话更宽时不会生效。
        </p>
      </label>

      <label className="space-y-1">
        <span className="text-muted-foreground text-[11px]">systemPrompt</span>
        <Textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="子代理的系统提示词"
          rows={4}
        />
      </label>

      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}

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
    </form>
  );
}
