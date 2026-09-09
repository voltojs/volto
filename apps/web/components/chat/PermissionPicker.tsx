'use client';

import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
const OPTIONS: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'read-only', label: '只读', hint: '读取放行，任何写入一律拒绝' },
  { value: 'ask', label: '询问', hint: '工作区内小改动放行，高风险操作先问你' },
  { value: 'auto', label: '自动', hint: '工作区内全放行，不可逆操作仍拒绝' },
  { value: 'full', label: '完全', hint: '不加限制，不再询问' },
];

const ICONS: Record<PermissionMode, typeof Shield> = {
  'read-only': ShieldOff,
  ask: ShieldCheck,
  auto: Shield,
  full: ShieldAlert,
};

/**
 * Pure display + callback, same reasoning as `ModelPicker`: the caller
 * decides whether `value` comes from a session or from local "pending"
 * state on the welcome screen, and where a change goes.
 */
export function PermissionPicker({ value, onChange }: PermissionPickerProps) {
  const Icon = ICONS[value];

  return (
    <Select
      items={OPTIONS}
      value={value}
      onValueChange={(next) => onChange(next as PermissionMode)}
    >
      <SelectTrigger size="sm" variant="ghost" className="font-mono">
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            value === 'full' ? 'text-destructive/80' : 'text-muted-foreground',
          )}
        />
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <div className="flex flex-col text-left">
                <span>{option.label}</span>
                <span className="text-muted-foreground text-xs">
                  {option.hint}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
