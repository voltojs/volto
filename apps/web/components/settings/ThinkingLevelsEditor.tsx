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
  /** Local UI truth of the master toggle. The parent echoes emitted maps
   * back through `value` — including the `undefined` this component fires on
   * "off" — so a prop-derived switch would flip itself straight back on mid-
   * interaction; it is seeded once from the mount map and then owned here.
   * Turning off means "this model carries no override at all": rows clear and
   * `onChange(undefined)` fires; turning back on re-seeds exactly like mount
   * does, from the latest tracked truth (see `seedSource`). */
  const [enabled, setEnabled] = useState(() => value !== undefined);
  /** Seed source for the toggle's re-seed: the LATEST map this component
   * mounted with or emitted from its own rows. The parent's `value` echo can
   * lag behind an edit or be cleared mid-session (the master toggle's own
   * `undefined`), so it is never authoritative for a re-seed; this ref is the
   * component's self-truth. A mount-only snapshot would roll back post-mount
   * edits on off→on (review fix, Important 1). */
  const seedSource = useRef<ThinkingLevelMap | undefined>(value);
  /** Rows the component OWNS (review fix, Important 1): the emitted map is
   * only a projection of them, so while the master toggle is off — when the
   * parent echoes `undefined` back — the rows must not be re-seeded from the
   * prop. Seeding from `value` happens exactly once, at mount, and `value` is
   * never adopted afterwards: ModelTable's draft map is stale while it does
   * not echo an emit back, so adopting it would roll back every edit. A
   * collapse/expand unmounts this component, so the next mount re-seeds from
   * whatever the parent currently holds. */
  const [rows, setRows] = useState<LevelRow[]>(() => seedRows(value, levels));
  /** Mirror of `rows` for reads outside the state updater: `commit` must
   * compute the next rows before rendering to emit a single `onChange` (not
   * once per StrictMode updater invocation), while still seeing edits made in
   * the same tick. */
  const rowsRef = useRef(rows);
  const nextKey = useRef(rows.length);

  /** Apply a row edit, then emit a fresh map built from the result. An empty
   * map means "no override" → undefined. Computing outside the `setRows`
   * updater keeps the parent patch to ONE call per edit: StrictMode
   * deliberately double-invokes updaters, which would otherwise fire
   * `onChange` twice. `rowsRef` preserves the same-tick freshness the
   * updater form used to provide (e.g. right after a Select commit).
   * Every emitted truth — including `undefined` from deleting the last
   * override — is tracked in `seedSource` at emit time, so an off→on
   * round-trip re-seeds from the newest state even when the parent never
   * echoes it back. */
  const commit = (edit: (prev: LevelRow[]) => LevelRow[]) => {
    const next = edit(rowsRef.current);
    const map = mapFromRows(next);
    rowsRef.current = next;
    seedSource.current = map;
    setRows(next);
    onChange(map);
  };

  /** Flip the master toggle. Off clears the rows and emits `undefined` —
   * "this model carries no override at all" — but KEEPS the tracked truth in
   * `seedSource`: that is what an off→on round-trip re-seeds from, so post-
   * mount edits survive (review fix, Important 1). On re-seeds exactly like
   * mount does, from the latest tracked truth. */
  const toggle = (next: boolean) => {
    setEnabled(next);
    if (!next) {
      setRows([]);
      rowsRef.current = [];
      // No `seedSource` write here: the off-emit reports the current state
      // ("no override"), it does not erase the user's row work.
      onChange(undefined);
      return;
    }
    // Seed from the LATEST truth — never the stale prop. While off the
    // parent echoes `undefined` back through `value`, so `seedRows(value,…)`
    // would degrade to pure defaults and roll back every edit. An untouched
    // round-trip still equals the mount seeding, both start from the same map.
    const seeded = seedRows(seedSource.current, levels);
    const map = mapFromRows(seeded);
    rowsRef.current = seeded;
    seedSource.current = map;
    setRows(seeded);
    onChange(map);
  };

  /** The effective wire value for a tier, or the localized off fallback. */
  const placeholderFor = (id: ThinkingLevelId): string | undefined => {
    const level = levels?.find((l) => l.id === id);
    return level?.value ?? (id === 'off' ? t('models.levelOff') : undefined);
  };

  /** Rows are unique per tier by construction, so a full-length set is the
   * full seven-tier list; adding another can only duplicate. */
  const allTiersPresent = rows.length >= ALL_LEVELS.length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          {t('models.thinkingLevels')}
        </span>
        {/* The visible label text IS the switch's accessible name — the
         * aria-label would be added on top of it and double the name
         * ("启用推理等级覆盖 启用推理等级覆盖"). The title above is a separate
         * string so RTL queries never collide with it. */}
        <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
          <Switch checked={enabled} onCheckedChange={toggle} />
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
            disabled={allTiersPresent}
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
