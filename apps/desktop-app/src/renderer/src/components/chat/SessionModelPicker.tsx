// apps/desktop-app/src/renderer/src/components/chat/SessionModelPicker.tsx
/**
 * SessionModelPicker
 * 对话页顶栏的会话级模型选择器：展示/切换当前会话绑定的供应商+模型。
 * 切换后立即持久化绑定并触发该会话的 Agent 重建（携带历史），不需要
 * 等到下一条消息才生效。
 */

import { useMemo } from "react";
import { Cpu } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/renderer/src/components/ui/select";
import { useStoreValue } from "@/renderer/src/hooks/use-store";
import { useChatStore } from "@/renderer/src/stores/chat-store";
import { useAgent } from "@/renderer/src/hooks/use-agent";
import type { ProviderConfig } from "@/renderer/src/components/settings/ProvidersPanel";

export interface SessionModelPickerProps {
  sessionId: string;
}

/** 用 "providerId::modelId" 拼接成 Select 需要的单一 value */
function toValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function SessionModelPicker({ sessionId }: SessionModelPickerProps) {
  const { value: providers, loading } = useStoreValue<ProviderConfig[]>("providers", []);
  const session = useChatStore((s) => s.sessions.get(sessionId));
  const bindSessionModel = useChatStore((s) => s.bindSessionModel);
  const { create } = useAgent();

  const currentValue = useMemo(() => {
    if (!session?.providerId || !session?.modelId) return "";
    // 会话绑定的供应商/模型可能已被删除；此时不应展示一个失效的 value，
    // 否则 Radix Select 会因找不到匹配的 SelectItem 而渲染为空白/异常。
    const provider = providers.find((p) => p.id === session.providerId);
    const model = provider?.models.find((m) => m.id === session.modelId);
    if (!provider || !model) return "";
    return toValue(session.providerId, session.modelId);
  }, [session?.providerId, session?.modelId, providers]);

  const handleChange = async (next: string) => {
    const [providerId, modelId] = next.split("::");
    if (!providerId || !modelId) return;
    bindSessionModel(sessionId, providerId, modelId);
    // 立即重建该会话的 Agent 实例，让下一条消息就用新模型（携带历史，见
    // agent-manager.create() 里对 sessionMessages 的重新读取与转换）。
    await create(sessionId);
  };

  if (loading) return null;

  if (providers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-4 py-2">
        还没有配置任何供应商，请先在设置 → 模型中添加供应商
      </p>
    );
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b">
      <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <Select value={currentValue} onValueChange={(v) => void handleChange(v)}>
        <SelectTrigger className="h-7 text-xs w-auto min-w-[180px]">
          <SelectValue placeholder="选择模型" />
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => (
            <SelectGroup key={provider.id}>
              <SelectLabel>{provider.name}</SelectLabel>
              {provider.models.map((model) => (
                <SelectItem key={model.id} value={toValue(provider.id, model.id)}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
