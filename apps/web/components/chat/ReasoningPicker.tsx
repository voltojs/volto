'use client';

import { Brain } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ReasoningEffort } from '@/lib/config-api';

interface ReasoningPickerProps {
  efforts: ReasoningEffort[];
  value: string | undefined;
  onChange: (effort: string) => void;
}

/**
 * Pure display + callback, mirroring `ModelPicker` — has no opinion on
 * whether it is picking an effort for a session that already exists or one
 * that hasn't been created yet. Effort ids and names are opaque strings the
 * server declares; this component never hardcodes or interprets them.
 */
export function ReasoningPicker({
  efforts,
  value,
  onChange,
}: ReasoningPickerProps) {
  // A model with no reasoning capability offers nothing to choose — the
  // control disappears entirely rather than rendering a disabled shell.
  if (efforts.length === 0) {
    return null;
  }

  const items = efforts.map((effort) => ({
    value: effort.id,
    label: effort.name,
  }));

  return (
    <Select
      items={items}
      value={value ?? null}
      onValueChange={(next) => onChange(String(next))}
    >
      <SelectTrigger size="sm" variant="ghost" className="font-mono">
        <Brain className="text-primary/80 h-3.5 w-3.5" />
        <SelectValue placeholder="推理等级" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {efforts.map((effort) => (
          <SelectItem key={effort.id} value={effort.id}>
            {effort.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
