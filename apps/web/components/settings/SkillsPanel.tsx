'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSkills } from '@/hooks/use-skills';
import type { SkillEntry } from '@/lib/agent-config';

interface SkillsPanelProps {
  projectId: string | null;
}

const GROUPS = [
  { scope: 'user' as const, label: '用户级', dir: '~/.volto/skills' },
  { scope: 'project' as const, label: '项目级', dir: '.volto/skills' },
];

/**
 * Which invocation policy needs a badge. The default (model + manual) carries
 * none — a badge on every row would hide the exceptions it exists to surface.
 */
function invocationLabel(skill: SkillEntry): string | null {
  if (!skill.modelInvocable && !skill.userInvocable) return '不可调用';
  if (!skill.modelInvocable) return '仅手动调用';
  if (!skill.userInvocable) return '仅模型调用';
  return null;
}

function SkillRow({ skill }: { skill: SkillEntry }) {
  const badge = invocationLabel(skill);
  return (
    <div
      data-skill-row=""
      data-skill-id={skill.id}
      className="space-y-1.5 rounded-md border p-2.5 text-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">
          {skill.shadowed ? `${skill.name}（shadowed）` : skill.name}
        </span>
        {badge && <Badge variant="outline">{badge}</Badge>}
      </div>
      {skill.description && (
        <p className="text-muted-foreground line-clamp-2 text-xs">{skill.description}</p>
      )}
      {skill.shadowed && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          此定义已被更高优先级的同名定义覆盖，不生效——编辑它不会改变技能的实际行为。
        </p>
      )}
      <p
        className="text-muted-foreground truncate font-mono text-[11px]"
        title={skill.filePath}
      >
        {skill.filePath}
      </p>
    </div>
  );
}

/**
 * Settings catalog for skills: a read-only list grouped by the two on-disk
 * sources. The gateway returns every definition (including shadowed losers)
 * because "my edit had no effect" must be self-diagnosable from this panel.
 */
export function SkillsPanel({ projectId }: SkillsPanelProps) {
  const { skills, status, refresh } = useSkills(projectId);

  if (status === 'loading') {
    return <p className="text-muted-foreground text-sm">正在加载技能…</p>;
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm" role="alert">
        <AlertCircle className="text-destructive h-4 w-4" />
        <span>无法加载技能定义。</span>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          技能从下列两个目录发现；修改 SKILL.md 后点击刷新。
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void refresh()}
        >
          <RefreshCw />
          刷新
        </Button>
      </div>

      {GROUPS.map((group) => {
        const entries = skills.filter((skill) => skill.scope === group.scope);
        const label =
          group.scope === 'project' && projectId === null
            ? `${group.label}（网关默认目录）`
            : group.label;
        return (
          <section key={group.scope} data-skill-group={group.scope} className="space-y-2">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-medium">{label}</h3>
              <code className="text-muted-foreground font-mono text-[11px]">{group.dir}</code>
              <span className="text-muted-foreground ml-auto text-xs">
                {entries.length} 个
              </span>
            </div>
            {entries.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                还没有技能。每个技能一个子目录，目录内放 SKILL.md。
              </p>
            ) : (
              entries.map((skill) => <SkillRow key={skill.id} skill={skill} />)
            )}
          </section>
        );
      })}
    </div>
  );
}
