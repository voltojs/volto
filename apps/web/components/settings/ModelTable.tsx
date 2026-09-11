'use client';

import { useState } from 'react';
import { ListPlus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { Model } from '@/stores/config-store';
import type { CatalogProviderModel } from '@/lib/config-api';
import { AvailableModelsDialog } from './AvailableModelsDialog';

/**
 * A draft model row needs a React key that stays stable for the row's whole
 * lifetime, including while `id` is still `''` (a newly-added, unsaved row).
 * `clientKey` exists only for that purpose and is stripped before the draft
 * is sent to the server — the server-side contract (empty/omitted `id` means
 * "assign a new UUID") is unchanged.
 *
 * `reasoning` is normalized to a plain boolean here even though the wire
 * `Model.reasoning` is a resolved `{ efforts, defaultEffort? }` object (or
 * absent) — the gateway always re-derives that object from the stored
 * boolean flag plus pi-ai's own catalog metadata, so the draft only needs to
 * track "on/off" and never invents effort ids itself.
 */
export interface DraftModel {
  clientKey: string;
  id: string;
  name: string;
  code: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning: boolean;
}

export function toDraftModels(models: Model[]): DraftModel[] {
  return models.map((m) => ({
    clientKey: m.id || crypto.randomUUID(),
    id: m.id,
    name: m.name,
    code: m.code,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    reasoning: Boolean(m.reasoning),
  }));
}

/**
 * Catalog models have no server-assigned id — they are keyed by pi-ai's own
 * code. `reasoning` is the gateway-resolved capability (pi-ai's catalog,
 * possibly suppressed by a stored override), normalized to a checkbox seed.
 */
export function toCatalogDrafts(models: CatalogProviderModel[]): DraftModel[] {
  return models.map((m) => ({
    clientKey: m.code || crypto.randomUUID(),
    id: '',
    name: m.name ?? '',
    code: m.code,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    reasoning: Boolean(m.reasoning),
  }));
}

export function emptyDraftModel(): DraftModel {
  return {
    clientKey: crypto.randomUUID(),
    id: '',
    name: '',
    code: '',
    reasoning: false,
  };
}

/** Reads a positive-integer field, mapping an empty box back to "unset". */
function parsePositiveInt(raw: string): number | undefined {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits === '' ? undefined : Number(digits);
}

/**
 * Column widths, shared by the header and every row so the two stay aligned.
 * Model id and display name take the slack; the two token caps are numeric
 * and narrow; the trailing two columns are fixed-size controls.
 */
const GRID =
  'grid grid-cols-[1.4fr_1.2fr_5.5rem_5.5rem_2.5rem_1.75rem] gap-1.5';

/**
 * The model list as one form row per model — every field of a model is
 * directly editable in place, with no per-row expand step.
 */
export function ModelTable({
  models,
  onChange,
  codeOptions,
  codeListId,
  emptyHint,
}: {
  models: DraftModel[];
  onChange: (next: DraftModel[]) => void;
  /**
   * Known models offered as code autocomplete (typing a new code stays
   * allowed). Their `name` / token caps are also shown as each row's
   * placeholders — the value inherited when that box is left empty.
   * Matching a code also seeds that row's reasoning checkbox from the
   * catalog flag, so a newly added reasoning model starts checked.
   */
  codeOptions?: Array<{
    code: string;
    name: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
  }>;
  /** Must be unique per rendered table when `codeOptions` is given. */
  codeListId?: string;
  /** Shown in place of the default empty-state line. */
  emptyHint?: string;
}) {
  const patch = (index: number, next: Partial<DraftModel>) =>
    onChange(models.map((m, i) => (i === index ? { ...m, ...next } : m)));

  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedCodes = models.map((m) => m.code).filter((c) => c.trim());

  return (
    <div className="space-y-1.5">
      {codeOptions && codeListId && (
        <datalist id={codeListId}>
          {codeOptions.map((o) => (
            <option key={o.code} value={o.code} label={o.name} />
          ))}
        </datalist>
      )}
      {models.length > 0 && (
        <div
          className={`${GRID} text-muted-foreground px-1 text-[10px] font-medium tracking-wider uppercase`}
        >
          <span>模型 ID</span>
          <span>显示名称</span>
          <span>上下文窗口</span>
          <span>最大输出</span>
          <span className="text-center">推理</span>
          <span />
        </div>
      )}

      {models.map((model, index) => {
        const inherited = codeOptions?.find((o) => o.code === model.code);
        return (
          <div key={model.clientKey} className={`${GRID} items-center`}>
            <Input
              className="h-8 font-mono text-xs"
              value={model.code}
              placeholder="model-id"
              aria-label={`模型 ID ${index + 1}`}
              list={codeOptions ? codeListId : undefined}
              onChange={(e) => {
                const code = e.target.value;
                const match = codeOptions?.find((o) => o.code === code);
                patch(index, {
                  code,
                  // Seed from the catalog only when the typed code matches;
                  // a later toggle still wins until the code changes again.
                  ...(match?.reasoning !== undefined
                    ? { reasoning: match.reasoning }
                    : {}),
                });
              }}
            />
            <Input
              className="h-8 text-xs"
              value={model.name}
              placeholder={inherited?.name ?? '展示名'}
              aria-label={`显示名称 ${index + 1}`}
              onChange={(e) => patch(index, { name: e.target.value })}
            />
            {/* Both caps are optional: empty means "use the provider's own
              default", which is why neither shows a fabricated number. */}
            <Input
              className="h-8 font-mono text-xs"
              inputMode="numeric"
              value={model.contextWindow ?? ''}
              placeholder={
                inherited?.contextWindow === undefined
                  ? '默认'
                  : String(inherited.contextWindow)
              }
              aria-label={`上下文窗口 ${index + 1}`}
              onChange={(e) =>
                patch(index, {
                  contextWindow: parsePositiveInt(e.target.value),
                })
              }
            />
            <Input
              className="h-8 font-mono text-xs"
              inputMode="numeric"
              value={model.maxOutputTokens ?? ''}
              placeholder={
                inherited?.maxOutputTokens === undefined
                  ? '默认'
                  : String(inherited.maxOutputTokens)
              }
              aria-label={`最大输出 Token ${index + 1}`}
              onChange={(e) =>
                patch(index, {
                  maxOutputTokens: parsePositiveInt(e.target.value),
                })
              }
            />
            <div className="flex justify-center">
              <Checkbox
                checked={model.reasoning}
                aria-label={`支持推理 ${index + 1}`}
                onCheckedChange={(checked) =>
                  patch(index, { reasoning: checked === true })
                }
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onChange(models.filter((_, i) => i !== index))}
              aria-label={`删除模型 ${index + 1}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        );
      })}

      {models.length === 0 && (
        <p className="text-muted-foreground py-2 text-xs">
          {emptyHint ?? '还没有添加模型'}
        </p>
      )}

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground gap-1"
          onClick={() => onChange([...models, emptyDraftModel()])}
        >
          <Plus className="h-3 w-3" />
          新增模型
        </Button>
        {codeOptions && codeOptions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1"
            onClick={() => setPickerOpen(true)}
          >
            <ListPlus className="h-3 w-3" />
            获取可用模型
          </Button>
        )}
      </div>

      {codeOptions && (
        <AvailableModelsDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          options={codeOptions}
          selectedCodes={selectedCodes}
          onAdd={(codes) => {
            const byCode = new Map(codeOptions.map((o) => [o.code, o]));
            const added = codes.map((code) => {
              const match = byCode.get(code);
              return {
                clientKey: crypto.randomUUID(),
                id: '',
                // Empty name / caps inherit the catalog values through
                // placeholders, same as typing a matching code by hand.
                name: '',
                code,
                reasoning: match?.reasoning ?? false,
              } satisfies DraftModel;
            });
            onChange([...models, ...added]);
          }}
        />
      )}
    </div>
  );
}
