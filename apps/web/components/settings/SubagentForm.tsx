'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
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
  /**
   * Routing tiers for the model dropdown. `null` means the fetch has not
   * settled yet: the list is unknown, so nothing may be judged stale.
   */
  tiers: RoutingTier[] | null;
  onSubmit: (payload: SubagentFormSubmit) => void | Promise<void>;
  onCancel: () => void;
  /** Edit-mode only: open straight in the delete confirmation (row trash button). */
  startConfirmingDelete?: boolean;
} & (
  | { mode: 'create'; entry?: undefined; onDelete?: undefined }
  | { mode: 'edit'; entry: AgentEntry; onDelete?: () => void | Promise<void> }
);

const SANDBOX_OPTIONS = [
  { value: 'read-only', labelKey: 'subagentForm.permissionReadOnly' },
  // Labels avoid the words used by the two required notes below (workspace /
  // project scope): getByText(/工作区/) must resolve to exactly one element.
  { value: 'workspace-write', labelKey: 'subagentForm.permissionWorkspace' },
  { value: 'danger-full-access', labelKey: 'subagentForm.permissionFull' },
] as const;

type SandboxMode = (typeof SANDBOX_OPTIONS)[number]['value'];

/**
 * Base UI Select rejects empty-string values, so "inherit the parent model"
 * is carried by a sentinel option value and mapped back to `model: undefined`
 * on submit — the wire semantics stay "absent field = inherit".
 */
const MODEL_INHERIT_VALUE = '__inherit__';


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
  const t = useTranslations('settings');
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
  // dropped behind the user's back. Staleness needs the settled list: while
  // `tiers` is null the fetch may still come back with this very tier, so
  // the reference is not stale yet — only "fetch settled and the id is
  // absent" is.
  const staleModel =
    spec?.model &&
    tiers !== null &&
    !tiers.some((tier) => tier.id === spec.model)
      ? spec.model
      : undefined;
  const modelOptions: ModelOption[] = [
    { value: MODEL_INHERIT_VALUE, label: t('subagentForm.inheritModel') },
    ...(staleModel
      ? [{ value: staleModel, label: t('subagentForm.staleTier', { model: staleModel }), disabled: true }]
      : []),
    // Unassigned tiers stay selectable: the D5 degrade path falls back to
    // the parent model at dispatch time, so the suffix is a heads-up, not
    // a block.
    ...(tiers?.map((tier) => ({
      value: tier.id,
      label: tier.target
        ? tier.label
        : t('subagentForm.unconfiguredTier', { label: tier.label }),
    })) ?? []),
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
      setError(err instanceof Error ? err.message : t('subagentForm.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} data-agent-form="">
      <FieldGroup>
        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-name">{t('subagentForm.name')}</FieldLabel>
          <Input
            id="agent-name"
            className="h-8"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('subagentForm.namePlaceholder')}
            required
          />
        </Field>

        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-description">{t('subagentForm.description')}</FieldLabel>
          <Textarea
            id="agent-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('subagentForm.descriptionPlaceholder')}
            rows={2}
          />
        </Field>

        {mode === 'create' && (
          <FieldSet aria-label={t('subagentForm.scope')}>
            <FieldLegend>{t('subagentForm.scope')}</FieldLegend>
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
                  {t('subagentForm.scopeProject')}
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem value="user" id="agent-scope-user" />
                <FieldLabel htmlFor="agent-scope-user" id="agent-scope-user-label">
                  {t('subagentForm.scopeUser')}
                </FieldLabel>
              </Field>
            </RadioGroup>
            {scope === 'project' && (
              // Required copy (F-028): a project-level write lands in
              // .volto/agents inside the repo, so the workspace gains a git
              // change the user did not make in their editor. Wording avoids
              // 「项目级」 so the scope radio labels stay unique matches.
              <FieldDescription className="text-amber-600 dark:text-amber-500">
                {t('subagentForm.writeHint')}
              </FieldDescription>
            )}
          </FieldSet>
        )}

        <FieldSet aria-label={t('subagentForm.tools')}>
          <FieldLegend>{t('subagentForm.tools')}</FieldLegend>
          {tools.length === 0 && (
            <FieldDescription>
              {t('subagentForm.toolsEmpty')}
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
          <FieldLabel htmlFor="agent-model">{t('subagentForm.model')}</FieldLabel>
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
            items={SANDBOX_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
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
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* Required copy (F-029): a child can only narrow its parent's
              sandbox, so a wider choice here reads as broken rather than
              narrowed unless the form says so up front. */}
          <FieldDescription>
            {t('subagentForm.sandboxHint')}
          </FieldDescription>
        </Field>

        <Field orientation="vertical">
          <FieldLabel htmlFor="agent-system-prompt">systemPrompt</FieldLabel>
          <Textarea
            id="agent-system-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('subagentForm.promptPlaceholder')}
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
              {t('subagentForm.deleteTitle', { name: entry.name })}{' '}
              <code className="font-mono text-xs">
                {entry.filePath ?? entry.id}
              </code>
              {t('subagentForm.deleteUndoable')}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void onDelete?.()}
              >
                {t('subagentForm.confirmDelete')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
              >
                {t('subagentForm.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving
                ? t('subagentForm.saving')
                : mode === 'create'
                  ? t('subagentForm.creating')
                  : t('subagentForm.save')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {t('subagentForm.cancel')}
            </Button>
            {mode === 'edit' && onDelete && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                {t('subagentForm.delete')}
              </Button>
            )}
          </div>
        )}
      </FieldGroup>
    </form>
  );
}
