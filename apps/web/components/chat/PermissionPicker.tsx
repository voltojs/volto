'use client';

import { ShieldCheck, ShieldAlert } from 'lucide-react';
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

const OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'plan', label: '规划模式' },
  { value: 'auto-accept', label: '完全权限' },
];

/**
 * Pure display + callback, same reasoning as `ModelPicker`: the caller
 * decides whether `value` comes from a session or from local "pending"
 * state on the welcome screen, and where a change goes.
 */
export function PermissionPicker({ value, onChange }: PermissionPickerProps) {
  return (
    <Select
      items={OPTIONS}
      value={value}
      onValueChange={(next) => onChange(next as PermissionMode)}
    >
      <SelectTrigger size="sm" variant="ghost" className="font-mono">
        {value === 'auto-accept' ? (
          <ShieldAlert className="text-destructive/80 h-3.5 w-3.5" />
        ) : (
          <ShieldCheck className={cn('text-muted-foreground h-3.5 w-3.5')} />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
