'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAgents } from '@/hooks/use-agents';
import {
  createAgent,
  deleteAgent,
  updateAgent,
  type AgentEntry,
} from '@/lib/agents-api';
import {
  fetchRoutingTiers,
  type RoutingTier,
} from '@/lib/routing-tiers-api';
import { providerModels, useConfigStore } from '@/stores/config-store';
import type { CatalogProvider, Provider } from '@/lib/config-api';
import { SubagentForm, type SubagentFormSubmit } from './SubagentForm';

interface SubagentsPanelProps {
  projectId: string | null;
}

const SCOPE_LABEL_KEY: Record<AgentEntry['scope'], string> = {
  project: 'subagents.scopeProject',
  user: 'subagents.scopeUser',
  plugin: 'subagents.scopePlugin',
  builtin: 'subagents.scopeBuiltin',
};

/** Which form, if any, currently replaces the list. */
type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; entry: AgentEntry; startConfirmingDelete?: boolean }
  | null;

/** Tools shown inline before the "+N" overflow badge takes over. */
const VISIBLE_TOOL_COUNT = 2;

/**
 * Tool badges for one agent row: the first `VISIBLE_TOOL_COUNT` names inline,
 * the rest folded into a single "+N" badge whose tooltip lists them.
 */
function ToolBadges({ tools }: { tools: readonly string[] }) {
  if (tools.length === 0) return null;
  const visible = tools.slice(0, VISIBLE_TOOL_COUNT);
  const hidden = tools.slice(VISIBLE_TOOL_COUNT);
  return (
    <span className="flex items-center gap-1">
      {visible.map((tool) => (
        <Badge key={tool} variant="outline" className="font-mono text-[10px]">
          {tool}
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" className="text-[10px]">
                +{hidden.length}
              </Badge>
            }
          />
          <TooltipContent className="max-w-64 flex-wrap">
            {hidden.join('、')}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Settings tab listing every agent definition the gateway can resolve
 * (project / user / plugin), with the flags that explain why an entry may
 * not be the one in effect. Same-named entries stay adjacent (server returns
 * higher-priority scopes first) so a shadowed twin reads as a pair.
 * Create / edit / delete go through `mutate`, which refetches the whole
 * list — `shadowed` is recomputed server-side, so a local patch cannot
 * get it right.
 */
/**
 * A sub-agent's model choice is a routing tier id (or absent = inherit the
 * main conversation). The list must say which one is in effect: a stale id
 * reads as stale rather than as inheritance, and an unassigned tier says so.
 * Staleness waits for the tier fetch to settle, matching the form.
 */
function ModelBadge({
  model,
  tiers,
  providers,
  catalogProviders,
}: {
  model: string | undefined;
  tiers: RoutingTier[] | null;
  providers: readonly Provider[];
  catalogProviders: readonly CatalogProvider[];
}) {
  const t = useTranslations('settings');
  if (!model) return <Badge variant="secondary">{t('subagents.inherit')}</Badge>;
  const tier = tiers?.find((candidate) => candidate.id === model);
  if (tier === undefined) {
    return (
      <Badge variant="outline">
        {tiers === null
          ? t('subagents.route', { model })
          : t('subagents.routeStale', { model })}
      </Badge>
    );
  }
  if (!tier.target) {
    return <Badge variant="outline">{t('subagents.routeUnconfigured', { label: tier.label })}</Badge>;
  }
  // Prefer the user-facing names; fall back to the raw ids when the provider
  // list has not loaded, the provider was deleted, or the model is gone.
  const target = tier.target;
  const provider = providers.find((candidate) => candidate.id === target.providerId);
  const providerName = provider?.name ?? target.providerId;
  const targetModel = provider
    ? providerModels(provider, catalogProviders).find(
        (candidate) => candidate.id === target.modelId || candidate.code === target.modelId,
      )
    : undefined;
  const modelName = targetModel?.name ?? target.modelId;
  const effortName =
    targetModel?.reasoning?.efforts.find((effort) => effort.id === tier.reasoningEffort)?.name ??
    tier.reasoningEffort;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline">{t('subagents.route', { model: tier.label })}</Badge>}
      />
      <TooltipContent>
        {providerName} / {modelName}
        {effortName ? t('subagents.inference', { effort: effortName }) : ''}
      </TooltipContent>
    </Tooltip>
  );
}

export function SubagentsPanel({ projectId }: SubagentsPanelProps) {
  const t = useTranslations('settings');
  const { agents, tools, status, refresh, mutate } = useAgents(projectId);
  const [form, setForm] = useState<FormState>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // `null` = the tier fetch has not settled yet; a list (even an empty
  // one) is the settled answer, including the degraded empty list a failed
  // fetch falls back to. The form must not judge staleness before settle.
  const [tiers, setTiers] = useState<RoutingTier[] | null>(null);
  const providers = useConfigStore((state) => state.providers);
  const catalogProviders = useConfigStore((state) => state.catalogProviders);

  // Routing tiers feed the form's model dropdown. A failed load is not a
  // form error: the dropdown degrades to the inherit-only list and saving
  // still works — but it still settles (to an empty list) so a stale
  // spec.model reads as stale only once the answer is known.
  useEffect(() => {
    let cancelled = false;
    void fetchRoutingTiers()
      .then((list) => {
        if (!cancelled) setTiers(list);
      })
      .catch(() => {
        if (!cancelled) setTiers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (payload: SubagentFormSubmit) => {
    if (payload.mode === 'create') {
      await mutate(() =>
        createAgent({ scope: payload.scope, spec: payload.spec }, projectId),
      );
    } else {
      await mutate(() => updateAgent(payload.id, payload.spec, projectId));
    }
    setForm(null);
    setActionError(null);
  };

  const handleDelete = async (entry: AgentEntry) => {
    try {
      await mutate(() => deleteAgent(entry.id, projectId));
      setForm(null);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('subagents.deleteFailed'));
    }
  };

  // The catalogue the child could actually be granted. A declared name
  // outside it is dropped at dispatch — surface it here, where it is fixable.
  const toolNames = new Set(tools.map((tool) => tool.name));

  if (status === 'loading') {
    return (
      <p className="text-muted-foreground text-sm">{t('subagents.loading')}</p>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm" role="alert">
        <AlertCircle className="text-destructive h-4 w-4" />
        <span>{t('subagents.loadFailed')}</span>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t('subagents.retry')}
        </Button>
      </div>
    );
  }

  if (form) {
    // Split branches rather than a spread: the discriminated-union props of
    // SubagentForm do not survive a conditional spread through TypeScript.
    return (
      <div className="space-y-2">
        {actionError && (
          <p className="text-destructive text-sm" role="alert">
            {actionError}
          </p>
        )}
        {form.mode === 'create' ? (
          <SubagentForm
            mode="create"
            tools={tools}
            tiers={tiers}
            onSubmit={(payload) => handleSubmit(payload)}
            onCancel={() => {
              setForm(null);
              setActionError(null);
            }}
          />
        ) : (
          <SubagentForm
            mode="edit"
            tools={tools}
            tiers={tiers}
            entry={form.entry}
            // The row trash button opens straight into the confirmation;
            // the pencil opens the editable fields. Built-ins are editable
            // but never deletable — no confirmation UI for them at all.
            startConfirmingDelete={form.startConfirmingDelete === true}
            onDelete={
              form.entry.builtIn === true ? undefined : () => void handleDelete(form.entry)
            }
            onSubmit={(payload) => handleSubmit(payload)}
            onCancel={() => {
              setForm(null);
              setActionError(null);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {actionError && (
        <p className="text-destructive text-sm" role="alert">
          {actionError}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          data-action="create"
          onClick={() => {
            setActionError(null);
            setForm({ mode: 'create' });
          }}
        >
          <Plus />
          {t('subagents.create')}
        </Button>
      </div>

      {agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('subagents.emptyBefore')}{' '}
          <code className="font-mono">~/.volto/agents</code> {t('subagents.emptyOr')}{' '}
          <code className="font-mono">.volto/agents</code>{' '}
          {t('subagents.emptyAfter')}
        </p>
      ) : (
        agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            tierList={tiers}
            providers={providers}
            catalogProviders={catalogProviders}
            knownTools={toolNames}
            onEdit={() => {
              setActionError(null);
              setForm({ mode: 'edit', entry: agent });
            }}
            onDelete={() => {
              setActionError(null);
              setForm({
                mode: 'edit',
                entry: agent,
                startConfirmingDelete: true,
              });
            }}
          />
        ))
      )}
    </div>
  );
}

/**
 * One list row. Extracted so the "declared but unavailable" computation can
 * live next to the rendering it explains: a definition naming a tool this
 * gateway does not expose is exactly the loss `subagent_tools_dropped`
 * reports at runtime, and it is knowable here without running anything.
 */
function AgentRow({
  agent,
  tierList,
  providers,
  catalogProviders,
  knownTools,
  onEdit,
  onDelete,
}: {
  agent: AgentEntry;
  tierList: RoutingTier[] | null;
  providers: readonly Provider[];
  catalogProviders: readonly CatalogProvider[];
  knownTools: ReadonlySet<string>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('settings');
  // Only a declared list can be wrong; an omitted `tools` inherits a set the
  // catalogue cannot judge.
  const missingTools = (agent.spec.tools ?? []).filter((name) => !knownTools.has(name));
  return (
          <div
            data-agent-row=""
            data-agent-id={agent.id}
            className="space-y-1.5 rounded-md border p-2.5 text-sm"
          >
            {/* Line 1: identity — name, scope, tools. */}
            <div className="flex min-w-0 items-center gap-2">
              {/* Shadowed rows append a qualifier so the bare name stays unique
                  to the winning definition. The qualifier avoids the warning's
                  Chinese phrasing so only the warning matches /被.*覆盖|不生效/. */}
              <span className="font-medium truncate">
                {agent.shadowed ? `${agent.name}（shadowed）` : agent.name}
              </span>
              <Badge variant="secondary">{t(SCOPE_LABEL_KEY[agent.scope])}</Badge>
              <ModelBadge
                model={agent.spec.model}
                tiers={tierList}
                providers={providers}
                catalogProviders={catalogProviders}
              />
              {/* An omitted `tools` means the child inherits the parent's
                  set — say so, because "no badges" would read as "no tools"
                  (built-in general-purpose renders exactly like that). */}
              {agent.spec.tools === undefined ? (
                <Badge variant="outline" className="text-[10px]">
                  {t('subagents.toolsInherit')}
                </Badge>
              ) : (
                <ToolBadges tools={agent.spec.tools} />
              )}
              <div className="ml-auto flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-action="edit"
                  disabled={agent.readOnly}
                  aria-label={t('subagents.ariaEdit', { name: agent.name })}
                  onClick={onEdit}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-action="delete"
                  // A built-in is configurable but never removable: neither
                  // its implicit row nor its override file can be deleted.
                  disabled={agent.readOnly || agent.builtIn === true}
                  aria-label={t('subagents.ariaDelete', { name: agent.name })}
                  onClick={onDelete}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>

            {/* Line 2: description, clamped at two lines. */}
            {agent.description && (
              <p className="text-muted-foreground line-clamp-2 text-xs">
                {agent.description}
              </p>
            )}
            {missingTools.length > 0 && (
              // This is the same loss `subagent_tools_dropped` reports at
              // dispatch time, known statically: the definition names a tool
              // this gateway does not expose, so the child will never get it.
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t('subagents.toolsUnavailable', {
                  tools: missingTools.join('、'),
                })}
              </p>
            )}
            {agent.shadowed && (
              // Single text node: nested markup would let the same warning
              // match two elements under getByText's direct-text extraction.
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t('subagents.overridden')}
              </p>
            )}

            {/* Line 3: source file (truncated, full path in tooltip). */}
            {agent.filePath && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <p className="text-muted-foreground truncate font-mono text-[11px]">
                      {agent.filePath}
                    </p>
                  }
                />
                <TooltipContent className="max-w-96 break-all">
                  {agent.filePath}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
  );
}
