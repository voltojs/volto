'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, ListPlus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { Model } from '@/stores/config-store';
import type {
  CatalogProviderModel,
  ModelInputLimits,
  ModelInputValue,
} from '@/lib/config-api';
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
  /** 三态：undefined = 从未声明（UNKNOWN），展示为图片勾上；切换后只在两个显式值间摆动。 */
  input?: ModelInputValue;
  /** 仅展示种子（目录事实），custom 行恒无。 */
  inputLimits?: ModelInputLimits;
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
    input: m.input,
    inputLimits: undefined, // config-store `Model` has no limits; explicit keeps both converters shape-identical
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
    input: m.input,
    inputLimits: m.inputLimits,
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

/** 只拼实际存在的字段；全部缺失返回 undefined（调用方据此隐藏分组）。 */
function formatInputLimits(
  limits: ModelInputLimits | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | undefined {
  const resize = limits?.images?.resize;
  const parts: string[] = [];
  if (resize?.maxWidth !== undefined && resize?.maxHeight !== undefined) {
    parts.push(`≤${resize.maxWidth}×${resize.maxHeight}`);
  }
  if (resize?.maxBytes !== undefined) {
    parts.push(`≤${(resize.maxBytes / (1024 * 1024)).toFixed(1)}MB`);
  }
  if (resize?.jpegQuality !== undefined)
    parts.push(`JPEG ${resize.jpegQuality}`);
  if (limits?.images?.maxPerMessage !== undefined) {
    parts.push(t('models.limitPerMessage', { count: limits.images.maxPerMessage }));
  }
  if (limits?.images?.maxPerRequest !== undefined) {
    parts.push(t('models.limitPerRequest', { count: limits.images.maxPerRequest }));
  }
  if (limits?.maxRequestBytes !== undefined) {
    parts.push(
      t('models.limitRequest', {
        mb: (limits.maxRequestBytes / (1024 * 1024)).toFixed(1),
      }),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Column widths, shared by the header and every row so the two stay aligned.
 * Model id and display name take the slack; the two token caps are numeric
 * and narrow; the trailing three columns — reasoning, expand, delete — are
 * fixed-size controls.
 */
const GRID =
  'grid grid-cols-[1.4fr_1.2fr_5.5rem_5.5rem_2.5rem_1.75rem_1.75rem] gap-1.5';

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
    input?: ModelInputValue;
    inputLimits?: ModelInputLimits;
  }>;
  /** Must be unique per rendered table when `codeOptions` is given. */
  codeListId?: string;
  /** Shown in place of the default empty-state line. */
  emptyHint?: string;
}) {
  const t = useTranslations('settings');
  const patch = (index: number, next: Partial<DraftModel>) =>
    onChange(models.map((m, i) => (i === index ? { ...m, ...next } : m)));

  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const toggleOpen = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
          <span>{t('models.colId')}</span>
          <span>{t('models.colName')}</span>
          <span>{t('models.colContext')}</span>
          <span>{t('models.colMaxOutput')}</span>
          <span className="text-center">{t('models.colReasoning')}</span>
          <span />
          <span />
        </div>
      )}

      {models.map((model, index) => {
        const inherited = codeOptions?.find((o) => o.code === model.code);
        return (
          <Fragment key={model.clientKey}>
            <div className={`${GRID} items-center`}>
              <Input
                className="h-8 font-mono text-xs"
                value={model.code}
                placeholder="model-id"
                aria-label={t('models.ariaId', { n: index + 1 })}
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
                    ...(match !== undefined && match.input !== undefined
                      ? { input: match.input }
                      : {}),
                    ...(match !== undefined
                      ? { inputLimits: match.inputLimits }
                      : {}),
                  });
                }}
              />
              <Input
                className="h-8 text-xs"
                value={model.name}
                placeholder={inherited?.name ?? t('models.fieldName')}
                aria-label={t('models.ariaName', { n: index + 1 })}
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
                    ? t('models.default')
                    : String(inherited.contextWindow)
                }
                aria-label={t('models.ariaContext', { n: index + 1 })}
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
                    ? t('models.default')
                    : String(inherited.maxOutputTokens)
                }
                aria-label={t('models.ariaMaxOutput', { n: index + 1 })}
                onChange={(e) =>
                  patch(index, {
                    maxOutputTokens: parsePositiveInt(e.target.value),
                  })
                }
              />
              <div className="flex justify-center">
                <Checkbox
                  checked={model.reasoning}
                  aria-label={t('models.ariaReasoning', { n: index + 1 })}
                  onCheckedChange={(checked) =>
                    patch(index, { reasoning: checked === true })
                  }
                />
              </div>
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('models.ariaExpand', { n: index + 1 })}
                  onClick={() => toggleOpen(model.clientKey)}
                >
                  <ChevronRight
                    className={`h-3 w-3 transition-transform ${openKeys.has(model.clientKey) ? 'rotate-90' : ''}`}
                  />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => onChange(models.filter((_, i) => i !== index))}
                aria-label={t('models.ariaDelete', { n: index + 1 })}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            {openKeys.has(model.clientKey) && (
              <div className="border-muted-foreground/30 col-span-full space-y-2 border-l py-2 pl-3">
                <div className="space-y-1.5">
                  <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                    {t('models.inputTypes')}
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex cursor-not-allowed items-center gap-1.5 text-xs opacity-70">
                      <Checkbox
                        checked
                        disabled
                        aria-label={t('models.ariaInputText', { n: index + 1 })}
                      />
                      {t('models.inputText')}
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={model.input?.includes('image') ?? true}
                        aria-label={t('models.ariaInputImage', { n: index + 1 })}
                        onCheckedChange={(checked) =>
                          patch(index, {
                            input:
                              checked === true ? ['text', 'image'] : ['text'],
                          })
                        }
                      />
                      {t('models.inputImage')}
                    </label>
                  </div>
                  {/* D3: 文本恒在；未声明(UNKNOWN)按有效行为(放行)显示为勾上，切换才产生显式声明。 */}
                </div>
                {formatInputLimits(model.inputLimits, t) !== undefined && (
                  <div className="space-y-1.5">
                    <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                      {t('models.inputLimits')}
                    </div>
                    <p
                      className="text-muted-foreground font-mono text-xs"
                      aria-label={t('models.ariaInputLimits')}
                    >
                      {formatInputLimits(model.inputLimits, t)}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Fragment>
        );
      })}

      {models.length === 0 && (
        <p className="text-muted-foreground py-2 text-xs">
          {emptyHint ?? t('models.empty')}
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
          {t('models.add')}
        </Button>
        {codeOptions && codeOptions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1"
            onClick={() => setPickerOpen(true)}
          >
            <ListPlus className="h-3 w-3" />
            {t('models.fetch')}
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
                input: match?.input,
                inputLimits: match?.inputLimits,
              } satisfies DraftModel;
            });
            onChange([...models, ...added]);
          }}
        />
      )}
    </div>
  );
}
