'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  ThinkingLevelId,
  ThinkingLevelInfo,
  ThinkingLevelMap,
} from '@/lib/config-api';

/** The seven tiers in display order — mirror of `ThinkingLevelId`. */
const ALL_LEVELS: ThinkingLevelId[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** One editor row: a tier plus its override state (`null` = unsupported). */
interface LevelRow {
  /** Position-based identity, stable across tier changes — like ModelTable's
   * `clientKey`, so editing a row never remounts its Base UI Select. */
  clientKey: string;
  level: ThinkingLevelId;
  /** undefined = inherit (empty box), string = explicit value, null = unsupported. */
  override: string | null | undefined;
}

/** Rows the table starts with: every declared override, then the levels the
 * gateway reports as supported defaults (an override already shown is not
 * duplicated). Without `levels` info, all seven tiers are offered. */
function seedRows(
  value: ThinkingLevelMap | undefined,
  levels: ThinkingLevelInfo[] | undefined,
): LevelRow[] {
  const entries = Object.entries(value ?? {}) as [ThinkingLevelId, string | null][];
  const overridden = new Set(entries.map(([id]) => id));
  const rows: LevelRow[] = entries.map(([level, override], i) => ({
    clientKey: `seed-${i}`,
    level,
    override,
  }));
  const defaults =
    levels && levels.length > 0
      ? levels.filter((l) => l.supported && !overridden.has(l.id as ThinkingLevelId))
      : ALL_LEVELS.filter((id) => !overridden.has(id)).map((id) => ({ id }));
  for (const level of defaults) {
    rows.push({
      clientKey: `seed-${rows.length}`,
      level: level.id as ThinkingLevelId,
      override: undefined,
    });
  }
  return rows;
}

/** The map a row set emits — shared by `commit` and the master toggle's
 * re-seed so both use the same "empty map = no override" rule. */
function mapFromRows(rows: LevelRow[]): ThinkingLevelMap | undefined {
  const map: ThinkingLevelMap = {};
  for (const row of rows) {
    if (row.override !== undefined) map[row.level] = row.override;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * The per-model "tier → API parameter value" table used in the ModelTable
 * expand area. Pure display + callback: it owns no store access and never
 * mutates the incoming map — every change rebuilds a fresh object from the
 * rows' entries, because the map is shared by reference with the zustand
 * wire records upstream.
 */
export function ThinkingLevelsEditor({
  value,
  levels,
  onChange,
}: {
  value: ThinkingLevelMap | undefined;
  levels: ThinkingLevelInfo[] | undefined;
  onChange: (next: ThinkingLevelMap | undefined) => void;
}) {
  const t = useTranslations('settings');
  /** Local UI truth of the master toggle: "on" iff the incoming map carries
   * an override. Turning it off means "this model has no override at all" —
   * rows disappear and `onChange(undefined)` fires; turning it back on
   * re-seeds exactly like mount does. The switch is NOT derived from the
   * `value` prop: while off the parent echoes `undefined` back, which would
   * flip a prop-derived state straight on again mid-interaction. */
  const [enabled, setEnabled] = useState(() => value !== undefined);
  /** Seed source for the toggle's re-seed: the map the component mounted with,
   * so an off→on round-trip survives the parent echoing `undefined` back
   * through `value`. User edits need no capture — every non-empty edit emits
   * a map, and ModelTable's reasoning linkage remounts this subtree on the
   * undefined→map transition, which reseeds from that fresh prop. */
  const seedSource = useRef<ThinkingLevelMap | undefined>(value);
  const [rows, setRows] = useState<LevelRow[]>(() =>
    enabled ? seedRows(value, levels) : [],
  );
  const nextKey = useRef(rows.length);

  /** Apply a row edit, then emit a fresh map built from the result. An empty
   * map means "no override" → undefined. The updater form keeps `rows` fresh
   * across re-renders (a stale closure would drop edits made in the same
   * tick, e.g. right after a Select commit closes the popup). */
  const commit = (edit: (prev: LevelRow[]) => LevelRow[]) => {
    setRows((prev) => {
      const next = edit(prev);
      onChange(mapFromRows(next));
      return next;
    });
  };

  /** Flip the master toggle. Off clears the rows and emits `undefined`; on
   * re-seeds exactly like mount does, from the props' ORIGINAL truth kept in
   * `seedSource`. */
  const toggle = (next: boolean) => {
    setEnabled(next);
    if (!next) {
      setRows([]);
      onChange(undefined);
      return;
    }
    const seeded = seedRows(seedSource.current, levels);
    setRows(seeded);
    onChange(mapFromRows(seeded));
  };

  /** The effective wire value for a tier, or the localized off fallback. */
  const placeholderFor = (id: ThinkingLevelId): string | undefined => {
    const level = levels?.find((l) => l.id === id);
    return level?.value ?? (id === 'off' ? t('models.levelOff') : undefined);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          {t('models.thinkingLevels')}
        </span>
        {/* The switch's own label is a separate string from the title so RTL
         * queries never collide; Base UI exposes it as the accessible name. */}
        <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            aria-label={t('models.thinkingLevelsToggle')}
          />
          {t('models.thinkingLevelsToggle')}
        </label>
      </div>
      {enabled && (
        <>
          <p className="text-muted-foreground text-xs">{t('models.hint')}</p>
          <div className="grid grid-cols-[7.5rem_1fr_auto_1.75rem] items-center gap-1.5">
            <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              {t('models.colLevel')}
            </span>
            <span className="text-muted-foreground flex items-center gap-1 text-[10px] font-medium tracking-wider uppercase">
              {t('models.colApiValue')}
              <span className="font-normal normal-case tracking-normal opacity-70">
                ({t('models.inheritDefault')})
              </span>
            </span>
            <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
              {t('models.unsupported')}
            </span>
            <span />
            {rows.map((row, index) => {
              const n = index + 1;
              const taken = new Set(
                rows.filter((_, i) => i !== index).map((other) => other.level),
              );
              return (
                <div key={row.clientKey} className="contents">
                  <Select
                    items={ALL_LEVELS.map((id) => ({ value: id, label: id }))}
                    value={row.level}
                    onValueChange={(next) => {
                      const level = String(next) as ThinkingLevelId;
                      // Picking a tier seeds the row's value to the tier id
                      // itself: xhigh/max are unsupported until explicitly
                      // mapped in pi-ai, so an empty row would silently do
                      // nothing — the "UI claims it is available, the request
                      // cannot carry it" failure this feature must avoid. The
                      // tier id is exactly pi-ai's own wire fallback
                      // (`map[level] ?? level`). A user-typed value survives the
                      // tier change; a cleared box still means inherit.
                      commit((prev) =>
                        prev.map((r, i) => {
                          if (i !== index) return r;
                          const typed =
                            r.override !== undefined &&
                            r.override !== null &&
                            r.override !== r.level;
                          return { ...r, level, override: typed ? r.override : level };
                        }),
                      );
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-7 w-full font-mono text-xs"
                      aria-label={t('models.colLevel') + ' ' + n}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent width="content">
                      {ALL_LEVELS.map((id) => (
                        <SelectItem key={id} value={id} disabled={taken.has(id)}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="h-7 font-mono text-xs"
                    value={row.override ?? ''}
                    // Empty string, never undefined: "no default to show" must
                    // still clear a previously rendered tier's placeholder.
                    placeholder={placeholderFor(row.level) ?? ''}
                    disabled={row.override === null}
                    aria-label={t('models.colApiValue') + ' ' + n}
                    onChange={(e) => {
                      const raw = e.target.value;
                      commit((prev) =>
                        prev.map((r, i) =>
                          i === index ? { ...r, override: raw === '' ? undefined : raw } : r,
                        ),
                      );
                    }}
                  />
                  <div className="flex justify-center">
                    <Checkbox
                      checked={row.override === null}
                      aria-label={t('models.unsupported') + ' ' + n}
                      onCheckedChange={(checked) =>
                        commit((prev) =>
                          prev.map((r, i) =>
                            i === index
                              ? { ...r, override: checked === true ? null : undefined }
                              : r,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    aria-label={t('models.deleteLevel', { n })}
                    onClick={() => commit((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1"
            onClick={() => {
              const used = new Set(rows.map((r) => r.level));
              const free = ALL_LEVELS.find((id) => !used.has(id));
              if (!free) return;
              commit((prev) => [
                ...prev,
                { clientKey: `add-${nextKey.current++}`, level: free, override: undefined },
              ]);
            }}
          >
            <Plus className="h-3 w-3" />
            {t('models.addLevel')}
          </Button>
        </>
      )}
    </div>
  );
}
