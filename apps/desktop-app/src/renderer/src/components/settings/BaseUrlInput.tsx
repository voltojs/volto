/**
 * BaseUrlInput
 * 设置面板的自定义 baseURL 控件，用于接入任意 OpenAI 兼容服务。
 *
 * 直接走 `useStoreValue("baseURL", null)`：变更立即写到 electron-store；
 * 但 agent 实例只在下次 `agent:create` 时读取 wiring，所以需要 SettingsPanel
 * 顶层的"应用并重建 Agent"按钮才能真正让新值生效。
 *
 * 留空 = 未设置，wiring.ts 不会把 baseURL 传给 provider，走其内置官方地址；
 * 不做 URL 格式校验，出错交给实际请求时的 isError ToolResult / ModelError 归一化处理。
 */

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Button } from "@/renderer/src/components/ui/button";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useStoreValue } from "@/renderer/src/hooks/use-store";

export function BaseUrlInput() {
  const { value: stored, loading, update } = useStoreValue<string | null>("baseURL", null);
  const [draft, setDraft] = useState<string>(stored ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!loading) setDraft(stored ?? "");
  }, [loading, stored]);

  const dirty = (draft ?? "") !== (stored ?? "");

  const handleSave = async () => {
    const trimmed = draft.trim();
    await update(trimmed.length === 0 ? null : trimmed);
    setSavedAt(Date.now());
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium flex items-center gap-1">
          <Link2 className="h-3.5 w-3.5" />
          Base URL
        </Label>
        {dirty && <Badge variant="outline">未保存</Badge>}
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder="https://api.openai.com（留空使用官方地址）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (dirty) void handleSave();
          }}
          disabled={loading}
          className="flex-1 font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="outline" size="sm" disabled={loading || !dirty} onClick={() => void handleSave()}>
          保存
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        自定义 OpenAI 兼容服务地址，留空则使用官方 API。变更下次创建 Agent 时生效。
        {savedAt && (
          <>
            {" · "}
            <span className="text-emerald-600 dark:text-emerald-400">已保存</span>
          </>
        )}
      </p>
    </div>
  );
}
