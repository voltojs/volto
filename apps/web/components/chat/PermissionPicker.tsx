'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff, X } from 'lucide-react';
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
  /**
   * plan 态专用：点击徽标 hover 显形的 × 时退出计划（宿主切回进入前档
   * 位）。缺省不渲染退出入口（子代理面板等复用方无需退出语义）。
   */
  onExitPlan?: () => void;
  /**
   * Trigger chrome. The composer sits on another surface and wants the
   * borderless variant; a settings row sits beside ordinary selects and wants
   * the bordered one, so the caller picks rather than the component forcing a
   * look that only fits one of the two places.
   */
  variant?: 'default' | 'ghost';
  /** Extra trigger classes (width, for example), so callers need no wrapper. */
  triggerClassName?: string;
}

/**
 * The four presets, in escalating order — each one bundles a sandbox
 * boundary and an approval policy on the server.
 */
const OPTIONS: Array<{
  value: PermissionMode;
  /** Catalog keys, resolved at render so the menu follows the UI language. */
  labelKey: string;
  hintKey: string;
  Icon: typeof Shield;
  danger?: boolean;
}> = [
  {
    value: 'read-only',
    labelKey: 'permission.readOnly',
    hintKey: 'permission.readOnlyHint',
    Icon: ShieldOff,
  },
  {
    value: 'ask',
    labelKey: 'permission.ask',
    hintKey: 'permission.askHint',
    Icon: ShieldCheck,
  },
  {
    value: 'auto',
    labelKey: 'permission.auto',
    hintKey: 'permission.autoHint',
    Icon: Shield,
  },
  {
    value: 'full',
    labelKey: 'permission.full',
    hintKey: 'permission.fullHint',
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
export function PermissionPicker({
  value,
  onChange,
  onExitPlan,
  variant = 'ghost',
  triggerClassName,
}: PermissionPickerProps) {
  const t = useTranslations('chat');
  const [confirmFull, setConfirmFull] = useState(false);
  if (value === 'plan') {
    return (
      // 不挂 aria-disabled：徽标内含可交互的退出按钮，把容器标成禁用会让
      // 辅助技术与自动化工具把该按钮一并视为禁用（浏览器不拦点击，语义却
      // 撒谎）。"不可切换档位"的语义由 title 承载。
      <span
        title={t('permission.planTitle')}
        className="group text-muted-foreground border-border bg-muted/50 inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 font-mono text-xs select-none"
      >
        {t('permission.planActive')}
        {onExitPlan && (
          <button
            type="button"
            aria-label={t('permission.planExit')}
            onClick={onExitPlan}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
    );
  }
  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!;
  const Icon = selected.Icon;

  return (
    <>
      <Select
        items={OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
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
        <SelectTrigger
          size="sm"
          variant={variant}
          className={cn(variant === 'ghost' && 'font-mono', triggerClassName)}
        >
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
                      {t(option.labelKey)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t(option.hintKey)}
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
            <AlertDialogTitle>{t('permission.fullConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('permission.fullConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmFull(false);
                onChange('full');
              }}
            >
              {t('permission.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
