'use client';

import { useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { PermissionMode } from '@/stores/session-store';
import { cn } from '@/lib/utils';

interface PermissionPickerProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

/**
 * The four presets, in escalating order — each one bundles a sandbox
 * boundary and an approval policy on the server.
 */
const OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  hint: string;
  Icon: typeof Shield;
  danger?: boolean;
}> = [
  {
    value: 'read-only',
    label: '只读',
    hint: '读取放行，任何写入一律拒绝',
    Icon: ShieldOff,
  },
  {
    value: 'ask',
    label: '询问',
    hint: '工作区内小改动放行，高风险操作先问你',
    Icon: ShieldCheck,
  },
  {
    value: 'auto',
    label: '自动',
    hint: '工作区内全放行，不可逆操作仍拒绝',
    Icon: Shield,
  },
  {
    value: 'full',
    label: '完全',
    hint: '不加限制，不再询问',
    Icon: ShieldAlert,
    danger: true,
  },
];

/**
 * Pure display + callback, same reasoning as `ModelPicker`: the caller
 * decides whether `value` comes from a session or from local "pending"
 * state on the welcome screen, and where a change goes.
 *
 * Switching into `full` is the one path that needs a second click — it
 * drops every sandbox and approval gate, so it is never one-click.
 *
 * `plan` is not a user-chosen preset: it is entered by the `/plan` action
 * command, so the picker degrades to a read-only badge instead of offering
 * the four presets (the server's plan preset also has no equivalent among
 * them — showing one would let the user "switch" to a mode the session
 * isn't in).
 */
export function PermissionPicker({ value, onChange }: PermissionPickerProps) {
  const [confirmFull, setConfirmFull] = useState(false);
  if (value === 'plan') {
    return (
      <span
        aria-disabled="true"
        title="退出计划：批准计划或手动切换权限"
        className="text-muted-foreground border-border bg-muted/50 inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 font-mono text-xs select-none"
      >
        计划中
      </span>
    );
  }
  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!;
  const Icon = selected.Icon;

  return (
    <>
      <Select
        items={OPTIONS}
        value={value}
        onValueChange={(next) => {
          const mode = next as PermissionMode;
          if (mode === 'full' && value !== 'full') {
            setConfirmFull(true);
            return;
          }
          onChange(mode);
        }}
      >
        <SelectTrigger size="sm" variant="ghost" className="font-mono">
          <Icon
            className={cn(
              'h-3.5 w-3.5',
              selected.danger
                ? 'text-destructive/80'
                : 'text-muted-foreground',
            )}
          />
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} width="content">
          <SelectGroup>
            {OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <div className="flex items-start gap-2 text-left">
                  <option.Icon
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      option.danger
                        ? 'text-destructive'
                        : 'text-muted-foreground',
                    )}
                  />
                  <div className="flex flex-col">
                    <span
                      className={option.danger ? 'text-destructive' : undefined}
                    >
                      {option.label}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {option.hint}
                    </span>
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <AlertDialog open={confirmFull} onOpenChange={setConfirmFull}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ShieldAlert className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>开启「完全」权限？</AlertDialogTitle>
            <AlertDialogDescription>
              将关闭沙箱与审批拦截，Agent
              可执行任意命令、任意读写文件，且不会再向你确认。仅在你完全信任当前任务时开启。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmFull(false);
                onChange('full');
              }}
            >
              确认开启
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
