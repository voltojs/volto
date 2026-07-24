/**
 * ModelSelector
 * 设置面板的模型名称输入控件。
 *
 * 行为：
 * - 不预设任何模型名称，纯文本输入，用户自行填写（配合任意 OpenAI 兼容服务）
 * - 直接走 useStoreValue("modelName", "")；本地 draft，失焦自动保存
 * - agent 行为下次 create 才生效（同 ApiKeyInput / BaseUrlInput），由 SettingsPanel 顶部按钮负责
 */

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useStoreValue } from "@/renderer/src/hooks/use-store";

export function ModelSelector() {
  const { value: stored, loading, update } = useStoreValue<string>("modelName", "");
  const [draft, setDraft] = useState<string>(stored ?? "");

  useEffect(() => {
    if (!loading) setDraft(stored ?? "");
  }, [loading, stored]);

  const dirty = (draft ?? "") !== (stored ?? "");

  const handleCommit = async () => {
    const trimmed = draft.trim();
    if (trimmed !== (stored ?? "")) {
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
        {dirty && <Badge variant="outline">未保存</Badge>}
      </div>

      <Input
        placeholder="输入模型名，如 gpt-4o / claude-3-5-sonnet / 自托管模型 ID"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void handleCommit()}
        disabled={loading}
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
      />

      <p className="text-xs text-muted-foreground">
        变更下次创建 Agent 时生效。模型名是否被接受由 baseURL 指向的服务端决定。
      </p>
    </div>
  );
}
