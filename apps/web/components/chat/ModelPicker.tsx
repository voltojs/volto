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
import { useSessionStore } from '@/stores/session-store';

interface ModelPickerProps {
  sessionId: string;
}

/** Value encoding: providerId and modelId joined, since Select carries one value. */
const encode = (providerId: string, modelId: string) => `${providerId}:${modelId}`;

export function ModelPicker({ sessionId }: ModelPickerProps) {
  const providers = useConfigStore((s) => s.providers);
  const isModelValid = useConfigStore((s) => s.isModelValid);
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId));

  const providerId = session?.providerId ?? null;
  const modelId = session?.modelId ?? null;
  const valid = isModelValid(providerId, modelId);

  const items = providers.flatMap((p) =>
    p.models.map((m) => ({ value: encode(p.id, m.id), label: m.name })),
  );

  return (
    <Select
      items={items}
      value={valid && providerId && modelId ? encode(providerId, modelId) : null}
      onValueChange={(next) => {
        const [nextProvider, nextModel] = String(next).split(':');
        if (nextProvider && nextModel) {
          useSessionStore.getState().setSessionModel(sessionId, nextProvider, nextModel);
        }
      }}
    >
      <SelectTrigger size="sm" className="font-mono">
        <Cpu className="h-3.5 w-3.5 text-primary/80" />
        {/* A session may reference a model that was since deleted; say so
            rather than silently falling back to some other model. */}
        <SelectValue placeholder={providerId && !valid ? '模型已失效，请重选' : '选择模型'} />
      </SelectTrigger>
      <SelectContent>
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
