'use client';

import { useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Cpu } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useConfigStore, providerModels } from '@/stores/config-store';
import type { ReasoningEffort } from '@/lib/config-api';

interface ModelSettingsPickerProps {
  providerId: string | null;
  modelId: string | null;
  onModelChange: (providerId: string, modelId: string) => void;
  /** Empty when the selected model declares no reasoning capability. */
  efforts: ReasoningEffort[];
  effort: string | undefined;
  onEffortChange: (effort: string) => void;
  /**
   * Trigger text when no model is selected. A picker whose empty state
   * means something concrete (an unassigned routing tier) names it here;
   * the default keeps the composer's prompt-like wording.
   */
  triggerFallback?: string;
  /**
   * Which side of the trigger the popup opens on. Hosts whose trigger sits
   * just above their submit actions (the tier form) pass 'top' so the
   * popup never covers them; the composer keeps the default.
   */
  side?: 'top' | 'bottom';
}

/** Which pane the popup is showing; the root lists both settings. */
type Pane = 'root' | 'model' | 'reasoning';

/**
 * Model and reasoning effort behind one trigger.
 *
 * They were two separate dropdowns competing for room in the input bar, and
 * they are not independent — the available efforts belong to the selected
 * model. Folding them into one control makes that relationship visible: the
 * root pane shows both current values, and drilling into either returns to
 * the root rather than closing, so changing a model and then its effort is
 * one interaction.
 *
 * Pure display + callbacks. It has no opinion on whether it is configuring a
 * session that already exists or one that hasn't been created yet, and it
 * never interprets effort ids — those are opaque strings the server
 * declares, rendered by the names it supplies.
 */
export function ModelSettingsPicker({
  providerId,
  modelId,
  onModelChange,
  efforts,
  effort,
  onEffortChange,
  triggerFallback,
  side = 'bottom',
}: ModelSettingsPickerProps) {
  const providers = useConfigStore((s) => s.providers);
  const catalogProviders = useConfigStore((s) => s.catalogProviders);
  const findModel = useConfigStore((s) => s.findModel);

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>('root');

  const model = findModel(providerId, modelId);
  const effortName = efforts.find((e) => e.id === effort)?.name;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Always reopen at the root: a popup that reopened mid-drill would
        // hide the setting the user did not go looking for.
        if (!next) setPane('root');
      }}
    >
      <PopoverTrigger
        className="hover:bg-muted flex h-7 max-w-80 items-center gap-1.5 rounded-[min(var(--radius-md),10px)] px-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none"
        aria-label="模型与推理等级"
      >
        <Cpu className="text-primary/80 h-3.5 w-3.5 shrink-0" />
        {/* A session can reference a model that was since deleted; say so
            rather than silently naming some other model. */}
        <span className="truncate font-mono">
          {model?.name ??
            (providerId
              ? '模型已失效，请重选'
              : (triggerFallback ?? '选择模型'))}
        </span>
        {effortName && (
          <span className="text-muted-foreground shrink-0 font-mono text-xs">
            {effortName}
          </span>
        )}
        <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
      </PopoverTrigger>

      <PopoverContent side={side} className="w-64 p-1">
        {pane === 'root' && (
          <>
            <Row
              label="模型"
              value={model?.name ?? '未选择'}
              onClick={() => setPane('model')}
            />
            {/* A model with no reasoning capability offers nothing to
                choose — the row disappears entirely rather than rendering a
                disabled shell. */}
            {efforts.length > 0 && (
              <Row
                label="推理等级"
                value={effortName ?? '默认'}
                onClick={() => setPane('reasoning')}
              />
            )}
          </>
        )}

        {pane === 'model' && (
          <>
            <BackRow label="模型" onClick={() => setPane('root')} />
            <div className="max-h-72 overflow-y-auto">
              {providers.map((provider) => {
                const models = providerModels(provider, catalogProviders);
                if (models.length === 0) return null;
                return (
                  <div key={provider.id}>
                    <div className="text-muted-foreground px-2 py-1 text-xs">
                      {provider.name}
                    </div>
                    {models.map((m) => (
                      <Option
                        key={m.id}
                        label={m.name}
                        selected={
                          provider.id === providerId && m.id === modelId
                        }
                        onClick={() => {
                          onModelChange(provider.id, m.id);
                          setPane('root');
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {pane === 'reasoning' && (
          <>
            <BackRow label="推理等级" onClick={() => setPane('root')} />
            <div className="max-h-72 overflow-y-auto">
              {efforts.map((e) => (
                <Option
                  key={e.id}
                  label={e.name}
                  selected={e.id === effort}
                  onClick={() => {
                    onEffortChange(e.id);
                    setPane('root');
                  }}
                />
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One root-pane setting: label on the left, current value + affordance right. */
function Row({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
    >
      <span className="flex-1">{label}</span>
      <span className="text-muted-foreground truncate font-mono text-xs">
        {value}
      </span>
      <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

/** Header of a drilled-in pane, doubling as the way back. */
function BackRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent mb-0.5 flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-sm font-medium"
    >
      <ChevronLeft className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

function Option({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
    >
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}
