'use client';

import { ShieldCheck } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSessionStore, type PermissionMode } from '@/stores/session-store';

interface PermissionPickerProps {
  sessionId: string;
}

const OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'plan', label: '规划模式' },
  { value: 'auto-accept', label: '完全权限' },
];

export function PermissionPicker({ sessionId }: PermissionPickerProps) {
  const mode = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.permissionMode ?? 'plan',
  );

  return (
    <Select
      items={OPTIONS}
      value={mode}
      onValueChange={(next) =>
        useSessionStore
          .getState()
          .setSessionPermissionMode(sessionId, next as PermissionMode)
      }
    >
      <SelectTrigger size="sm">
        <ShieldCheck className="h-3.5 w-3.5 text-gray-500" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
