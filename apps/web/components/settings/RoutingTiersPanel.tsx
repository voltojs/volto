'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

let nextClientKey = 0;

function toRow(tier: RoutingTier): TierRow {
  nextClientKey += 1;
  return {
    ...tier,
    target: { ...tier.target },
    clientKey: `tier-${nextClientKey}`,
  };
}

/** Draft → wire: the client key never reaches the gateway. */
function toWire(rows: TierRow[]): RoutingTier[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    target: { providerId: row.target.providerId, modelId: row.target.modelId },
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
 * Settings tab that maintains the model routing tier table: every tier is a
 * row of inline fields (id / label / description + provider / model target),
 * edited as a local draft and persisted by one full-table PUT. A 409 conflict
 * is shown inline — blocking (user/project) references as "无法删除", plugin
 * references as hints only — without losing the local list.
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

  const updateRow = (clientKey: string, patch: Partial<TierRow>) => {
    setRows((prev) =>
      prev.map((row) =>
        row.clientKey === clientKey ? { ...row, ...patch } : row,
      ),
    );
    setSaveError(null);
  };

  const handleAdd = () => {
    setRows((prev) => [
      ...prev,
      toRow({
        id: '',
        label: '',
        description: '',
        target: { providerId: '', modelId: '' },
      }),
    ]);
    setSaveError(null);
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

  const handleSave = async () => {
    try {
      await saveRoutingTiers(toWire(rows));
      setSaved(rows);
      setSaveError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.status === 409) {
        setRows((prev) => restoreRefusedRemovals(prev, saved));
        setSaveError({ message, ...readConflict(err.body) });
      } else {
        setSaveError({ message, references: [], skipped: [] });
      }
    }
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

  const blockingRefs = (saveError?.references ?? []).filter(
    (ref) => ref.scope !== 'plugin',
  );
  const pluginRefs = (saveError?.references ?? []).filter(
    (ref) => ref.scope === 'plugin',
  );
  const blockingText = `被 ${blockingRefs.map((ref) => ref.name).join('、')} 引用，无法删除`;

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
        <Button size="sm" onClick={() => void handleSave()}>
          <Save />
          保存
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">还没有模型路由档位。</p>
      ) : (
        rows.map((row, index) => {
          const provider = providers.find((p) => p.id === row.target.providerId);
          // Model options come from the store's own projection (catalog kinds
          // included) — never recomputed here.
          const models = provider
            ? providerModels(provider, catalogProviders)
            : [];
          return (
            <div
              key={row.clientKey}
              data-tier-row=""
              data-tier-id={row.id}
              className="space-y-1.5 rounded-md border p-2.5 text-sm"
            >
              <div className="flex flex-wrap items-end gap-2">
                <Field className="min-w-24 flex-1">
                  <FieldLabel htmlFor={`${row.clientKey}-id`}>id</FieldLabel>
                  <Input
                    id={`${row.clientKey}-id`}
                    className="h-8 font-mono text-xs"
                    value={row.id}
                    onChange={(e) =>
                      updateRow(row.clientKey, { id: e.target.value })
                    }
                  />
                </Field>
                <Field className="min-w-24 flex-1">
                  <FieldLabel htmlFor={`${row.clientKey}-label`}>
                    label
                  </FieldLabel>
                  <Input
                    id={`${row.clientKey}-label`}
                    className="h-8"
                    value={row.label}
                    onChange={(e) =>
                      updateRow(row.clientKey, { label: e.target.value })
                    }
                  />
                </Field>
                <Field className="min-w-32 flex-1">
                  <FieldLabel htmlFor={`${row.clientKey}-description`}>
                    description
                  </FieldLabel>
                  <Input
                    id={`${row.clientKey}-description`}
                    className="h-8"
                    value={row.description}
                    onChange={(e) =>
                      updateRow(row.clientKey, {
                        description: e.target.value,
                      })
                    }
                  />
                </Field>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Field className="min-w-32">
                  <FieldLabel htmlFor={`${row.clientKey}-provider`}>
                    provider
                  </FieldLabel>
                  <Select
                    items={providers.map((p) => ({
                      value: p.id,
                      label: p.name,
                    }))}
                    value={row.target.providerId || null}
                    onValueChange={(next) => {
                      // A model belongs to exactly one provider's list, so
                      // switching provider invalidates the old target.
                      updateRow(row.clientKey, {
                        target: {
                          providerId: String(next),
                          modelId: '',
                        },
                      });
                    }}
                  >
                    <SelectTrigger
                      id={`${row.clientKey}-provider`}
                      size="sm"
                      className="w-full"
                    >
                      <SelectValue placeholder="选择 provider" />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {providers.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <Field className="min-w-32">
                  <FieldLabel htmlFor={`${row.clientKey}-model`}>
                    model
                  </FieldLabel>
                  <Select
                    items={models.map((m) => ({
                      value: m.id,
                      label: m.name,
                    }))}
                    value={row.target.modelId || null}
                    disabled={provider === undefined}
                    onValueChange={(next) =>
                      updateRow(row.clientKey, {
                        target: {
                          providerId: row.target.providerId,
                          modelId: String(next),
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      id={`${row.clientKey}-model`}
                      size="sm"
                      className="w-full"
                    >
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <div className="ml-auto flex items-center">
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
                    data-action="delete"
                    aria-label={`删除 ${row.id || row.label || '新档位'}`}
                    onClick={() => handleDelete(row.clientKey)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
