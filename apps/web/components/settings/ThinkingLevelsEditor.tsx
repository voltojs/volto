'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

/** pi-ai's default-supported tiers: absent from the map they are offered,
 * an explicit `null` removes them. `off`/`xhigh`/`max` are not offered by
 * default, so an unlisted one is never encoded as `null`. */
const DEFAULT_SUPPORTED: ThinkingLevelId[] = ['minimal', 'low', 'medium', 'high'];

/** One editor row: the tier plus the exact string that will be sent. */
interface LevelRow {
  /** Stable per-tier identity (a tier appears at most once), so re-seeding
   * never remounts a row's Base UI Select. */
  clientKey: string;
  level: ThinkingLevelId;
  /** Never empty — `所见即所发`: the box content is always the wire value. */
  value: string;
}

/**
 * The real wire value for a tier, with no placeholder: a stored string
 * override wins, then the value the gateway reports for that tier, then
 * pi-ai's own fallback (`map[level] ?? level`), which is the tier id itself.
 */
function wireValueFor(
  level: ThinkingLevelId,
  value: ThinkingLevelMap | undefined,
  levels: ThinkingLevelInfo[] | undefined,
): string {
  const stored = value?.[level];
  if (typeof stored === 'string') return stored;
  return levels?.find((info) => info.id === level)?.value ?? level;
}

/**
 * Rows the table starts with: the tiers pi-ai reports as supported, plus any
 * tier with a stored string override. A stored `null` (the "not offered"
 * encoding) and an un-overridden `off` are excluded — the chat picker never
 * offers `off`. Tiers are always in the canonical seven-tier order.
 */
function seedRows(
  value: ThinkingLevelMap | undefined,
  levels: ThinkingLevelInfo[] | undefined,
): LevelRow[] {
  const reported = new Map((levels ?? []).map((info) => [info.id, info]));
  const rows: LevelRow[] = [];
  for (const level of ALL_LEVELS) {
    const stored = value?.[level];
    if (stored === null) continue;
    if (stored === undefined) {
      if (level === 'off') continue;
      if (reported.get(level)?.supported !== true) continue;
    }
    rows.push({
      clientKey: `seed-${level}`,
      level,
      value: wireValueFor(level, value, levels),
    });
  }
  return rows;
}

/**
 * The map a row set emits. Every listed tier contributes its value; every
 * default-supported tier that is not listed contributes `null`, so pi-ai
 * drops it from the supported set and the chat picker loses it too. `off`,
 * `xhigh` and `max` are never nulled when unlisted — they are already not
 * offered by default. An empty map means "no stored override" → `undefined`,
 * which lets pi-ai report its defaults untouched.
 */
function mapFromRows(rows: LevelRow[]): ThinkingLevelMap | undefined {
  const map: ThinkingLevelMap = {};
  const listed = new Set(rows.map((row) => row.level));
  for (const row of rows) map[row.level] = row.value;
  for (const level of DEFAULT_SUPPORTED) {
    if (!listed.has(level)) map[level] = null;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * The per-model "tier → API parameter value" table used in the ModelTable
 * expand area. The table is the single source of which tiers a model offers:
 * seeded from what pi-ai reports, listed rows are offered, deleted rows are
 * removed. Pure display + callback — it owns no store access and never
 * mutates the incoming map; every change rebuilds a fresh object from the
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
  /** Rows the component OWNS. Seeding happens once, at mount: the parent
   * echoes emitted maps back through `value`, and adopting that echo would
   * fight the local rows mid-edit. A collapse/expand unmounts this component,
   * so the next mount re-seeds from the latest draft map. */
  const [rows, setRows] = useState<LevelRow[]>(() => seedRows(value, levels));
  /** Mirror of `rows` for reads outside the state updater: every edit must
   * emit ONE `onChange` built from the freshest rows (StrictMode deliberately
   * double-invokes state updaters, which would otherwise emit twice). */
  const rowsRef = useRef(rows);
  const nextKey = useRef(rows.length);

  /** Apply a row edit, then emit a fresh map built from the result. */
  const commit = (edit: (prev: LevelRow[]) => LevelRow[]) => {
    const next = edit(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
    onChange(mapFromRows(next));
  };

  /** Rows are unique per tier by construction, so a full-length set is the
   * full seven-tier list; adding another can only duplicate. */
  const allTiersPresent = rows.length >= ALL_LEVELS.length;

  return (
    <div className="space-y-1.5">
      <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
        {t('models.thinkingLevels')}
      </span>
      <p className="text-muted-foreground text-xs">{t('models.levelsHint')}</p>
      <div className="grid grid-cols-[7.5rem_1fr_1.75rem] items-center gap-1.5">
        <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          {t('models.colLevel')}
        </span>
        <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          {t('models.colApiValue')}
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
                  // A new tier brings its own real wire value: keeping the
                  // previous tier's string would send a value that belongs to
                  // another tier, and an empty box would fall back silently.
                  commit((prev) =>
                    prev.map((r, i) =>
                      i === index
                        ? { ...r, level, value: wireValueFor(level, value, levels) }
                        : r,
                    ),
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
                value={row.value}
                aria-label={t('models.colApiValue') + ' ' + n}
                onChange={(e) => {
                  const raw = e.target.value;
                  // Emptying the box refills the tier id immediately: an empty
                  // box would otherwise send a value the user cannot see.
                  const next = raw === '' ? row.level : raw;
                  commit((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, value: next } : r)),
                  );
                }}
              />
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
      {!allTiersPresent && (
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
              { clientKey: `add-${nextKey.current++}`, level: free, value: free },
            ]);
          }}
        >
          <Plus className="h-3 w-3" />
          {t('models.addLevel')}
        </Button>
      )}
    </div>
  );
}
