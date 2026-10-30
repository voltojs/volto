'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Pencil,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ModelSettingsPicker } from '@/components/chat/ModelSettingsPicker';
import { ApiError } from '@/lib/config-api';
import {
  fetchRoutingTiers,
  saveRoutingTiers,
  type RoutingTier,
  type TierReference,
  type TierScanSkip,
} from '@/lib/routing-tiers-api';
import { providerModels, useConfigStore } from '@/stores/config-store';

/** Local draft row: a wire tier plus a key that survives user edits to `id`. */
interface TierRow extends RoutingTier {
  clientKey: string;
}

/** A failed save, kept until the next mutation or a successful save. */
interface SaveError {
  message: string;
  references: TierReference[];
  skipped: TierScanSkip[];
}

/** Which form, if any, currently replaces the list. */
type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; row: TierRow }
  | null;

/** The fields the tier form owns; `reasoningEffort` is cleared by a model change. */
interface TierFormData {
  id: string;
  label: string;
  description: string;
  target: { providerId: string; modelId: string } | null;
  reasoningEffort: string | undefined;
}

let nextClientKey = 0;

function toRow(tier: RoutingTier): TierRow {
  nextClientKey += 1;
  return {
    ...tier,
    target: tier.target ? { ...tier.target } : null,
    clientKey: `tier-${nextClientKey}`,
  };
}

/** Draft → wire: the client key never reaches the gateway. */
function toWire(rows: TierRow[]): RoutingTier[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    target: row.target
      ? { providerId: row.target.providerId, modelId: row.target.modelId }
      : null,
    reasoningEffort: row.reasoningEffort,
  }));
}

/**
 * A 409 that deletes nothing: rows the draft dropped go back to their saved
 * positions while unsaved edits and additions stay put, so the local list
 * still shows every tier the server kept ("无法删除" has to look true).
 */
function restoreRefusedRemovals(
  draft: TierRow[],
  saved: TierRow[],
): TierRow[] {
  const savedKeys = new Set(saved.map((row) => row.clientKey));
  const restored = saved.map(
    (row) => draft.find((d) => d.clientKey === row.clientKey) ?? row,
  );
  return [
    ...restored,
    ...draft.filter((row) => !savedKeys.has(row.clientKey)),
  ];
}

/** Narrows the untrusted 409 body to the fields the panel displays. */
function readConflict(body: unknown): {
  references: TierReference[];
  skipped: TierScanSkip[];
} {
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  return {
    references: Array.isArray(record.references)
      ? (record.references as TierReference[])
      : [],
    skipped: Array.isArray(record.skipped)
      ? (record.skipped as TierScanSkip[])
      : [],
  };
}

/**
 * Create / edit form for one tier. The dispatch target and its reasoning
 * effort live behind `ModelSettingsPicker`: the efforts offered belong to
 * the selected model's declared capability (same source ChatPanel reads),
 * and a model change resets the effort because it belonged to the model
 * being replaced.
 */
function TierForm({
  initial,
  onSubmit,
  onCancel,
  error,
}: {
  initial: TierFormData | null;
  onSubmit: (data: TierFormData) => void | Promise<void>;
  onCancel: () => void;
  error: string | null;
}) {
  const [id, setId] = useState(initial?.id ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [target, setTarget] = useState(initial?.target ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    initial?.reasoningEffort,
  );
  const reasoning = useConfigStore((s) =>
    s.getModelReasoning(target?.providerId ?? null, target?.modelId ?? null),
  );

  return (
    <form
      data-tier-form=""
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ id, label, description, target, reasoningEffort });
      }}
    >
      <Field>
        <FieldLabel htmlFor="tier-id">id</FieldLabel>
        <Input
          id="tier-id"
          className="h-8 font-mono text-xs"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="tier-label">label</FieldLabel>
        <Input
          id="tier-label"
          className="h-8"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="tier-description">description</FieldLabel>
        <Input
          id="tier-description"
          className="h-8"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <ModelSettingsPicker
        providerId={target?.providerId ?? null}
        modelId={target?.modelId ?? null}
        onModelChange={(providerId, modelId) => {
          setTarget({ providerId, modelId });
          setReasoningEffort(undefined);
        }}
        efforts={reasoning?.efforts ?? []}
        effort={reasoningEffort}
        onEffortChange={setReasoningEffort}
        triggerFallback="未配置模型"
        // The trigger sits right above the submit row: open upward so the
        // popup covers form fields (harmless) and never 保存/取消. This
        // form is hosted inside the modal settings dialog (z-50), so the
        // popup's layer is passed in as a full literal class name —
        // Tailwind's scanner must see the whole token to generate it.
        side="top"
        zIndexClassName="z-[60]"
      />
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          保存
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

/**
 * Settings tab that maintains the model routing tier table (SubagentsPanel-
 * style two-state UI). The list shows one card per tier — identity, copy,
 * the target model in the ModelSettingsPicker trigger shape, the tier's
 * reasoning effort — with move/edit/delete actions. Create and edit replace
 * the list with a form. The draft is persisted by one full-table PUT: only
 * reordering and form saves mutate locally, the save buttons PUT. A 409
 * conflict is shown inline in the list — blocking (user/project) references
 * as "无法删除", plugin references as hints only — without losing the list.
 */
export function RoutingTiersPanel() {
  const providers = useConfigStore((s) => s.providers);
  const catalogProviders = useConfigStore((s) => s.catalogProviders);
  const [rows, setRows] = useState<TierRow[]>([]);
  const [saved, setSaved] = useState<TierRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // No setState before the first await: the effect that bootstraps this
    // panel must not set state synchronously (react-hooks/set-state-in-effect).
    try {
      const loaded = (await fetchRoutingTiers()).map(toRow);
      setRows(loaded);
      setSaved(loaded);
      setSaveError(null);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // Async IIFE, not a bare `void load()`: the set-state-in-effect rule
    // flags the direct callback reference even though every setState in
    // `load` happens only after an await. Same shape as `use-agents`.
    void (async () => {
      await load();
    })();
  }, [load]);

  const handleAdd = () => {
    setSaveError(null);
    setFormError(null);
    setForm({ mode: 'create' });
  };

  const handleEdit = (row: TierRow) => {
    setSaveError(null);
    setFormError(null);
    setForm({ mode: 'edit', row });
  };

  const handleDelete = (clientKey: string) => {
    setRows((prev) => prev.filter((row) => row.clientKey !== clientKey));
    setSaveError(null);
  };

  /** Swap the draft row with its neighbour; the save button persists it. */
  const handleMove = (index: number, delta: -1 | 1) => {
    setRows((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const a = prev[index];
      const b = prev[target];
      if (a === undefined || b === undefined) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });
    setSaveError(null);
  };

  /** PUT the whole table; the outcome routes errors to the right surface. */
  const persist = async (
    next: TierRow[],
  ): Promise<
    | { status: 'ok' }
    | { status: 'conflict'; error: SaveError }
    | { status: 'error'; error: SaveError }
  > => {
    try {
      await saveRoutingTiers(toWire(next));
      // Write the saved draft back: the list renders `rows`, so without
      // this every form save snaps the panel back to pre-edit values.
      // Idempotent for handleSave, whose `next` already is `rows`.
      setRows(next);
      setSaved(next);
      return { status: 'ok' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.status === 409) {
        setRows(restoreRefusedRemovals(next, saved));
        return {
          status: 'conflict',
          error: { message, ...readConflict(err.body) },
        };
      }
      return {
        status: 'error',
        error: { message, references: [], skipped: [] },
      };
    }
  };

  const handleSave = async () => {
    const outcome = await persist(rows);
    setSaveError(outcome.status === 'ok' ? null : outcome.error);
  };

  const handleFormSubmit = async (data: TierFormData) => {
    setSaveError(null);
    const editing = form?.mode === 'edit' ? form : null;
    const next: TierRow[] = editing
      ? rows.map((row) =>
          row.clientKey === editing.row.clientKey
            ? { ...row, ...data, clientKey: row.clientKey }
            : row,
        )
      : [...rows, toRow(data)];
    const outcome = await persist(next);
    if (outcome.status === 'error') {
      // A fixable rejection (shape/resolve 400) keeps the form open so the
      // fix lands where the fields are; only the whole-table conflict is a
      // list concern (its restore touches rows the form cannot show).
      setFormError(outcome.error.message);
      return;
    }
    setForm(null);
    setFormError(null);
    if (outcome.status === 'conflict') setSaveError(outcome.error);
  };

  if (status === 'loading') {
    return (
      <p className="text-muted-foreground text-sm">正在加载模型路由档位…</p>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm" role="alert">
        <AlertCircle className="text-destructive h-4 w-4" />
        <span>无法加载模型路由档位。</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setStatus('loading');
            void load();
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  if (form) {
    return (
      <div className="space-y-2">
        <TierForm
          key={form.mode === 'edit' ? form.row.clientKey : 'create'}
          initial={
            form.mode === 'edit'
              ? {
                  id: form.row.id,
                  label: form.row.label,
                  description: form.row.description,
                  target: form.row.target,
                  reasoningEffort: form.row.reasoningEffort ?? undefined,
                }
              : null
          }
          onSubmit={handleFormSubmit}
          onCancel={() => {
            setForm(null);
            setFormError(null);
          }}
          error={formError}
        />
      </div>
    );
  }

  const blockingRefs = (saveError?.references ?? []).filter(
    (ref) => ref.scope !== 'plugin',
  );
  const pluginRefs = (saveError?.references ?? []).filter(
    (ref) => ref.scope === 'plugin',
  );
  const blockingText = `被 ${blockingRefs.map((ref) => ref.name).join('、')} 引用，无法删除`;

  // The save button retires unless the draft's row ORDER diverges from the
  // saved one. Compared as clientKey sequences: row CONTENT edits are the
  // form's business (it PUTs on submit), while adds/deletes also light the
  // button up — a deletion needs this button to reach the server at all.
  const orderDirty =
    rows.map((row) => row.clientKey).join() !==
    saved.map((row) => row.clientKey).join();

  /** Resolve a tier target against the provider registry for display. */
  const findTargetModel = (target: RoutingTier['target']) => {
    if (!target) return null;
    const provider = providers.find((p) => p.id === target.providerId);
    if (!provider) return null;
    return (
      providerModels(provider, catalogProviders).find(
        (m) => m.id === target.modelId,
      ) ?? null
    );
  };

  return (
    <div className="space-y-2">
      {saveError && (
        <div className="space-y-1">
          {/* Single text node per line so each warning matches exactly one
              element under getByText's direct-text extraction. */}
          <p className="text-destructive text-sm" role="alert">
            {blockingRefs.length > 0 ? blockingText : saveError.message}
          </p>
          {pluginRefs.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {`插件定义 ${pluginRefs.map((ref) => ref.name).join('、')} 也在引用该档位（仅提示，不阻塞删除）。`}
            </p>
          )}
          {saveError.skipped.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {`以下项目未能完成引用扫描：${saveError.skipped
                .map((skip) => `${skip.projectPath}（${skip.reason}）`)
                .join('、')}`}
            </p>
          )}
        </div>
      )}

      <div className="flex justify-end gap-1">
        <Button variant="outline" size="sm" onClick={handleAdd}>
          <Plus />
          新增档位
        </Button>
        <Button
          size="sm"
          disabled={!orderDirty}
          onClick={() => void handleSave()}
        >
          <Save />
          保存
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">还没有模型路由档位。</p>
      ) : (
        rows.map((row, index) => {
          const model = findTargetModel(row.target);
          const targetText = model?.name ?? (row.target ? '模型已失效' : '未配置模型');
          const effortText =
            row.reasoningEffort == null || row.reasoningEffort === ''
              ? null
              : (model?.reasoning?.efforts.find(
                  (e) => e.id === row.reasoningEffort,
                )?.name ?? row.reasoningEffort);
          return (
            <div
              key={row.clientKey}
              data-tier-row=""
              data-tier-id={row.id}
              className="space-y-1.5 rounded-md border p-2.5 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium truncate">{row.id}</span>
                {row.label && (
                  <span className="text-muted-foreground truncate">
                    {row.label}
                  </span>
                )}
                {/* Target shown in the ModelSettingsPicker trigger shape,
                    but display-only: editing happens through the form. */}
                <span className="flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),10px)] px-2.5 text-sm whitespace-nowrap">
                  <Cpu className="text-primary/80 h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono">{targetText}</span>
                </span>
                {effortText && (
                  <span className="text-muted-foreground font-mono text-xs">
                    {effortText}
                  </span>
                )}
                <div className="ml-auto flex shrink-0 gap-1">
                  {/* Order is part of the draft: moving a row only reorders
                      the local array; the save button PUTs the new order. */}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-action="move-up"
                    aria-label={`上移 ${row.id}`}
                    disabled={index === 0}
                    onClick={() => handleMove(index, -1)}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-action="move-down"
                    aria-label={`下移 ${row.id}`}
                    disabled={index === rows.length - 1}
                    onClick={() => handleMove(index, 1)}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-action="edit"
                    aria-label={`编辑 ${row.id || row.label || '新档位'}`}
                    onClick={() => handleEdit(row)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-action="delete"
                    aria-label={`删除 ${row.id || row.label || '新档位'}`}
                    onClick={() => handleDelete(row.clientKey)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {row.description && (
                <p className="text-muted-foreground line-clamp-2 text-xs">
                  {row.description}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
