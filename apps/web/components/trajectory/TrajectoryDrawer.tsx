'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Markdown } from '@/components/chat/Markdown';
import { usePaneStore } from '@/stores/pane-store';
import { cn } from '@/lib/utils';
import {
  EMPTY_CELL,
  KIND_BADGE_CLASS,
  KIND_LABELS,
  REMINDER_KIND_LABELS,
  TAB_LABELS,
  drawerTabsFor,
  formatDuration,
  locationLabel,
  parseSystemLayers,
} from '@/lib/trajectory-view-model';
import type { DrawerTabKey } from '@/lib/trajectory-view-model';
import type { TrajectoryRow } from '@volto/sdk/sse';

interface TrajectoryDrawerProps {
  row: TrajectoryRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-2 py-1.5 text-xs">
      <div className="text-muted-foreground pt-0.5">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Cell({ text }: { text: string | null | undefined }) {
  return text ? (
    <div className="text-foreground/90 whitespace-pre-wrap break-words">{text}</div>
  ) : (
    <span className="text-muted-foreground/60">{EMPTY_CELL}</span>
  );
}

function Code({ text }: { text: string }) {
  return (
    <pre className="bg-muted/60 text-foreground/80 overflow-x-auto rounded p-2 font-mono text-[11px]">
      {text}
    </pre>
  );
}

function OverviewTab({ row }: { row: TrajectoryRow }) {
  const t = useTranslations('trajectory');
  const duration = formatDuration(row.durationMs) ?? formatDuration(row.metrics?.durationMs);
  // 守卫保持原 truthiness 判断；落到 const 是因为属性收窄不带入 onClick 闭包。
  const childSessionId =
    row.kind === 'subagent' && row.childSessionId ? row.childSessionId : null;
  return (
    <div className="divide-y">
      <Field label={t('drawer.layer')}>
        <Cell text={locationLabel(row)} />
      </Field>
      <Field label={t('drawer.kind')}>
        <span
          className={cn(
            'inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium',
            KIND_BADGE_CLASS[row.kind],
          )}
        >
          {KIND_LABELS[row.kind]}
        </span>
      </Field>
      <Field label={t('drawer.status')}>
        {row.isError ? (
          <span className="text-destructive">{t('drawer.failed')}</span>
        ) : (
          <span className="text-success">{t('drawer.done')}</span>
        )}
      </Field>
      <Field label={t('drawer.duration')}>
        <Cell text={duration} />
      </Field>
      {row.kind === 'assistant' && row.metrics?.usage && (
        <>
          <Field label={t('drawer.inputTokens')}>
            <Cell
              text={
                row.metrics.usage.inputTokens !== undefined
                  ? String(row.metrics.usage.inputTokens)
                  : null
              }
            />
          </Field>
          <Field label={t('drawer.outputTokens')}>
            <Cell
              text={
                row.metrics.usage.outputTokens !== undefined
                  ? String(row.metrics.usage.outputTokens)
                  : null
              }
            />
          </Field>
          {(row.metrics.usage.cacheReadTokens ?? 0) > 0 && (
            <Field label={t('drawer.cacheHit')}>
              <Cell text={String(row.metrics.usage.cacheReadTokens)} />
            </Field>
          )}
        </>
      )}
      {childSessionId !== null && (
        <Field label={t('drawer.childSession')}>
          <div className="flex items-center justify-between gap-2">
            <code className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">
              {childSessionId}
            </code>
            <button
              type="button"
              onClick={() =>
                usePaneStore.getState().openTab({
                  kind: 'subagent',
                  id: `subagent:${childSessionId}`,
                  childSessionId,
                  view: 'trajectory',
                })
              }
              className="text-primary hover:bg-primary/10 shrink-0 rounded px-2 py-1 text-xs font-medium"
            >
              查看执行过程 →
            </button>
          </div>
        </Field>
      )}
      {row.reminderKind && (
        <Field label={t('drawer.source')}>
          <Cell text={REMINDER_KIND_LABELS[row.reminderKind]} />
        </Field>
      )}
    </div>
  );
}

export function TrajectoryDrawer({ row, open, onOpenChange }: TrajectoryDrawerProps) {
  const t = useTranslations('trajectory');
  if (row === null) {
    return (
      <Drawer open={false} onOpenChange={onOpenChange}>
        <DrawerContent title={t('drawer.title')} />
      </Drawer>
    );
  }

  const tabs = drawerTabsFor(row.kind);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        title={`${KIND_LABELS[row.kind]} · ${locationLabel(row)}`}
        description={row.summary}
      >
        {/* key 随行重挂：抽屉开着换行（store.open 另一行）时，内部受控
            Tabs 的激活值不能跨行残留。 */}
        <Tabs key={row.id} defaultValue={tabs[0]} className="min-h-0 flex-1">
          <TabsList className="mx-4 mt-3">
            {tabs.map((key) => (
              <TabsTrigger key={key} value={key}>
                {TAB_LABELS[key]}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {tabs.map((key) => (
              <TabsContent key={key} value={key} className="min-h-0">
                <TabBody row={row} tab={key} />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}

function TabBody({ row, tab }: { row: TrajectoryRow; tab: DrawerTabKey }) {
  const t = useTranslations('trajectory');
  switch (tab) {
    case 'overview':
      return <OverviewTab row={row} />;
    case 'input':
      return <Code text={row.inputDetail ?? EMPTY_CELL} />;
    case 'output': {
      // 错误行：整体红显、原样文本（含空 → 「（无）」）；正常行非空走 Markdown，
      // 空结果渲染占位而非空白 Markdown。
      if (row.isError) {
        return (
          <div className="text-destructive">
            <Cell text={row.outputDetail} />
          </div>
        );
      }
      return row.outputDetail ? <Markdown content={row.outputDetail} /> : <Cell text={row.outputDetail} />;
    }
    case 'schema':
      return <Code text={row.schemaDetail ?? EMPTY_CELL} />;
    case 'thinking':
      return <Cell text={row.thinkingDetail} />;
    case 'layers': {
      const layers = parseSystemLayers(row.inputDetail ?? '');
      if (layers.length === 0) return <Code text={row.inputDetail ?? EMPTY_CELL} />;
      return (
        <div className="space-y-3">
          {layers.map((layer) => (
            <div key={layer.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <code className="text-muted-foreground truncate font-mono text-[11px]">{layer.id}</code>
                <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px]">
                  {new TextEncoder().encode(layer.text).length} B
                </span>
              </div>
              <pre className="bg-muted/60 text-foreground/80 overflow-x-auto rounded p-2 font-mono text-[11px]">
                {layer.text}
              </pre>
            </div>
          ))}
        </div>
      );
    }
    case 'timing':
      return (
        <div className="divide-y">
          <Field label={t('drawer.startTime')}>
            <Cell text={new Date(row.startedAt).toLocaleString()} />
          </Field>
          <Field label={t('drawer.length')}>
            <Cell text={formatDuration(row.durationMs ?? row.metrics?.durationMs)} />
          </Field>
          {row.metrics?.ttftMs !== undefined && (
            <Field label="TTFT">
              <Cell text={formatDuration(row.metrics.ttftMs)} />
            </Field>
          )}
        </div>
      );
  }
}
