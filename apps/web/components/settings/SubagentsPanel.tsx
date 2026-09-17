'use client';

import { useState } from 'react';
import { AlertCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAgents } from '@/hooks/use-agents';
import {
  createAgent,
  deleteAgent,
  updateAgent,
  type AgentEntry,
} from '@/lib/agents-api';
import { SubagentForm, type SubagentFormSubmit } from './SubagentForm';

interface SubagentsPanelProps {
  projectId: string | null;
}

const SCOPE_LABEL: Record<AgentEntry['scope'], string> = {
  project: '项目',
  user: '用户',
  plugin: '插件',
};

/** Which form, if any, currently replaces the list. */
type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; entry: AgentEntry; startConfirmingDelete?: boolean }
  | null;

/**
 * Settings tab listing every agent definition the gateway can resolve
 * (project / user / plugin), with the flags that explain why an entry may
 * not be the one in effect. Same-named entries stay adjacent (server returns
 * higher-priority scopes first) so a shadowed twin reads as a pair.
 * Create / edit / delete go through `mutate`, which refetches the whole
 * list — `shadowed` is recomputed server-side, so a local patch cannot
 * get it right.
 */
export function SubagentsPanel({ projectId }: SubagentsPanelProps) {
  const { agents, tools, status, refresh, mutate } = useAgents(projectId);
  const [form, setForm] = useState<FormState>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      setActionError(err instanceof Error ? err.message : '删除失败');
    }
  };

  if (status === 'loading') {
    return (
      <p className="text-muted-foreground text-sm">正在加载子代理定义…</p>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm" role="alert">
        <AlertCircle className="text-destructive h-4 w-4" />
        <span>无法加载子代理定义。</span>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          重试
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
            entry={form.entry}
            // The row trash button opens straight into the confirmation;
            // the pencil opens the editable fields.
            startConfirmingDelete={form.startConfirmingDelete === true}
            onDelete={() => void handleDelete(form.entry)}
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
          新建子代理
        </Button>
      </div>

      {agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          还没有子代理定义。在 <code className="font-mono">.volto/agents</code>{' '}
          下添加 Markdown 文件后会自动出现。
        </p>
      ) : (
        agents.map((agent) => (
          <div
            key={agent.id}
            data-agent-row=""
            data-agent-id={agent.id}
            className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
          >
            {/* Shadowed rows append a qualifier so the bare name stays unique
                to the winning definition. The qualifier avoids the warning's
                Chinese phrasing so only the warning matches /被.*覆盖|不生效/. */}
            <span className="font-medium">
              {agent.shadowed ? `${agent.name}（shadowed）` : agent.name}
            </span>
            <Badge variant="secondary">{SCOPE_LABEL[agent.scope]}</Badge>
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {agent.description}
            </span>
            {agent.shadowed && (
              // Single text node: nested markup would let the same warning
              // match two elements under getByText's direct-text extraction.
              <p className="w-full text-xs text-amber-600 dark:text-amber-500">
                此定义已被更高优先级的同名定义覆盖，不生效——编辑它不会改变子代理的实际行为。
              </p>
            )}
            {agent.filePath && (
              <code className="text-muted-foreground text-xs">
                {agent.filePath}
              </code>
            )}
            <div className="ml-auto flex gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                data-action="edit"
                disabled={agent.readOnly}
                aria-label={`编辑 ${agent.name}`}
                onClick={() => {
                  setActionError(null);
                  setForm({ mode: 'edit', entry: agent });
                }}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                data-action="delete"
                disabled={agent.readOnly}
                aria-label={`删除 ${agent.name}`}
                onClick={() => {
                  setActionError(null);
                  setForm({
                    mode: 'edit',
                    entry: agent,
                    startConfirmingDelete: true,
                  });
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
