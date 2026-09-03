'use client';

import { Cpu } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore } from '@/stores/config-store';

interface ModelPickerProps {
  providerId: string | null;
  modelId: string | null;
  onChange: (providerId: string, modelId: string) => void;
}

/** Value encoding: providerId and modelId joined, since Select carries one value. */
const encode = (providerId: string, modelId: string) =>
  `${providerId}:${modelId}`;

/**
 * Pure display + callback — has no opinion on whether it is picking a model
 * for a session that already exists or one that hasn't been created yet.
 * The caller decides where `providerId`/`modelId` come from and where a
 * change goes (a session, via `setSessionModel`, or local "pending" state on
 * the welcome screen).
 */
export function ModelPicker({
  providerId,
  modelId,
  onChange,
}: ModelPickerProps) {
  const providers = useConfigStore((s) => s.providers);
  const isModelValid = useConfigStore((s) => s.isModelValid);
  const valid = isModelValid(providerId, modelId);

  const items = providers.flatMap((p) =>
    p.models.map((m) => ({ value: encode(p.id, m.id), label: m.name })),
  );

  return (
    <Select
      items={items}
      value={
        valid && providerId && modelId ? encode(providerId, modelId) : null
      }
      onValueChange={(next) => {
        const [nextProvider, nextModel] = String(next).split(':');
        if (nextProvider && nextModel) {
          onChange(nextProvider, nextModel);
        }
      }}
    >
      <SelectTrigger size="sm" className="font-mono">
        <Cpu className="text-primary/80 h-3.5 w-3.5" />
        {/* A session may reference a model that was since deleted; say so
            rather than silently falling back to some other model. */}
        <SelectValue
          placeholder={providerId && !valid ? '模型已失效，请重选' : '选择模型'}
        />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {providers.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectLabel>{provider.name}</SelectLabel>
            {provider.models.map((model) => (
              <SelectItem key={model.id} value={encode(provider.id, model.id)}>
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
