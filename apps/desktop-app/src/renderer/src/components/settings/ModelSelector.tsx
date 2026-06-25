/**
 * ModelSelector
 * 设置面板的模型选择控件。
 *
 * 行为：
 * - 预设几个常见 OpenAI 兼容模型（仅作为快捷下拉）
 * - 选择 "自定义" 时弹出文本输入框，用户写任意模型名（与自托管 / 第三方兼容服务配合）
 * - 直接走 useStoreValue("modelName", "gpt-4")；变更立即写盘
 * - agent 行为下次 create 才生效（同 ApiKeyInput），由 SettingsPanel 顶部按钮负责
 *
 * 注意：本应用当前 Provider 是 @volto/provider-openai，所以选项仅作 hint；
 * 模型名是个字符串字段，最终是否被 baseURL 后的 endpoint 接受由服务端决定。
 */

import { useEffect, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/renderer/src/components/ui/select";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useStoreValue } from "@/renderer/src/hooks/use-store";

const PRESETS = [
  { value: "gpt-4", label: "gpt-4" },
  { value: "gpt-4o", label: "gpt-4o" },
  { value: "gpt-4o-mini", label: "gpt-4o-mini" },
  { value: "gpt-4-turbo", label: "gpt-4-turbo" },
  { value: "gpt-3.5-turbo", label: "gpt-3.5-turbo" },
] as const;

const CUSTOM_SENTINEL = "__custom__";

export function ModelSelector() {
  const { value: stored, loading, update } = useStoreValue<string>("modelName", "gpt-4");

  // 判定当前 stored 是否落在预设里，否则视为自定义
  const initialIsCustom = useMemo(() => {
    if (!stored) return false;
    return !PRESETS.some((p) => p.value === stored);
  }, [stored]);

  const [mode, setMode] = useState<string>(initialIsCustom ? CUSTOM_SENTINEL : (stored ?? "gpt-4"));
  const [customDraft, setCustomDraft] = useState<string>(initialIsCustom ? (stored ?? "") : "");

  // 当 store 完成加载或外部变更时同步本地状态
  useEffect(() => {
    if (loading) return;
    if (initialIsCustom) {
      setMode(CUSTOM_SENTINEL);
      setCustomDraft(stored ?? "");
    } else {
      setMode(stored ?? "gpt-4");
    }
  }, [loading, stored, initialIsCustom]);

  const handleSelect = async (next: string) => {
    setMode(next);
    if (next === CUSTOM_SENTINEL) {
      // 切到自定义但还没填值时不立即写盘，等 customDraft 失焦
      return;
    }
    await update(next);
  };

  const handleCustomCommit = async () => {
    const trimmed = customDraft.trim();
    if (!trimmed) return;
    if (trimmed !== stored) {
      await update(trimmed);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium flex items-center gap-1">
          <Cpu className="h-3.5 w-3.5" />
          模型
        </Label>
        {!loading && stored && (
          <Badge variant="secondary" className="font-mono text-xs">
            {stored}
          </Badge>
        )}
      </div>

      <Select value={mode} onValueChange={(v) => void handleSelect(v)} disabled={loading}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="选择模型" />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SENTINEL}>自定义…</SelectItem>
        </SelectContent>
      </Select>

      {mode === CUSTOM_SENTINEL && (
        <Input
          placeholder="输入模型名，如 claude-3-5-sonnet 或自托管模型 ID"
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onBlur={() => void handleCustomCommit()}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
      )}

      <p className="text-xs text-muted-foreground">
        变更下次创建 Agent 时生效。当前 Provider 为 @volto/provider-openai；要切换到其它 baseURL
        需要在 wiring 层扩展，本面板暂不暴露 baseURL 设置。
      </p>
    </div>
  );
}
