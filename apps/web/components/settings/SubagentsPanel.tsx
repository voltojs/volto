'use client';

import { AlertCircle, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAgents } from '@/hooks/use-agents';
import type { AgentEntry } from '@/lib/agents-api';

interface SubagentsPanelProps {
  projectId: string | null;
}

const SCOPE_LABEL: Record<AgentEntry['scope'], string> = {
  project: '项目',
  user: '用户',
  plugin: '插件',
};

/**
 * Settings tab listing every agent definition the gateway can resolve
 * (project / user / plugin), with the flags that explain why an entry may
 * not be the one in effect. Same-named entries stay adjacent (server returns
 * higher-priority scopes first) so a shadowed twin reads as a pair.
 */
export function SubagentsPanel({ projectId }: SubagentsPanelProps) {
  const { agents, status, refresh } = useAgents(projectId);

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

  if (agents.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        还没有子代理定义。在 <code className="font-mono">.volto/agents</code>{' '}
        下添加 Markdown 文件后会自动出现。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {agents.map((agent) => (
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
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              data-action="delete"
              disabled={agent.readOnly}
              aria-label={`删除 ${agent.name}`}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
