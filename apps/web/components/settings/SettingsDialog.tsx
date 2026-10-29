'use client';

import { useState } from 'react';
import { Bot, KeyRound, SlidersHorizontal } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProvidersPanel } from './ProvidersPanel';
import { GeneralPanel } from './GeneralPanel';
import { SubagentsPanel } from './SubagentsPanel';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Current workspace's project id, when one is selected. Scopes the
   * subagents panel's list/create/update/delete to THIS workspace's
   * `.volto/agents` — without it the gateway resolves project-level
   * definitions against the gateway process cwd, so definitions created
   * here never take effect in workspace sessions (and existing ones are
   * invisible). Null keeps the gateway default (no workspace open).
   */
  projectId?: string | null;
}

const TABS = [
  { value: 'general', label: '通用设置', icon: SlidersHorizontal },
  { value: 'models', label: '模型配置', icon: KeyRound },
  { value: 'subagents', label: '子代理', icon: Bot },
] as const;

/** 设置面板：左侧 Tab 导航，右侧对应内容。 */
export function SettingsDialog({ open, onOpenChange, projectId = null }: SettingsDialogProps) {
  const [tab, setTab] = useState<string>('models');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        {/* min-w-0: the dialog is a grid, so this Tabs (its grid item) defaults
            to min-width auto — content with nowrap text (truncate rows) would
            push the panel past the dialog's max width instead of shrinking. */}
        <Tabs
          orientation="vertical"
          value={tab}
          onValueChange={(value) => setTab(String(value))}
          className="flex min-h-[60vh] min-w-0 flex-row gap-4"
        >
          <TabsList className="h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-0.5 self-start p-1">
            {TABS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-8 w-full flex-none justify-start gap-2"
              >
                <Icon className="h-4 w-4" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* min-w-0 so a long model code inside the panel scrolls instead of
              stretching the dialog past its max width. */}
          <div className="max-h-[60vh] min-w-0 flex-1 overflow-y-auto pr-1">
            <TabsContent value="models">
              <ProvidersPanel />
            </TabsContent>
            <TabsContent value="subagents">
              <SubagentsPanel projectId={projectId} />
            </TabsContent>
            <TabsContent value="general">
              <GeneralPanel />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
