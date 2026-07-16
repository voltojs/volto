/**
 * ApiKeyInput
 * 设置面板的 API Key 编辑控件：密码框 + 眼睛切换显隐 + 状态徽章。
 *
 * 直接走 `useStoreValue("apiKey", null)`：变更立即写到 electron-store；
 * 但 agent 实例只在下次 `agent:create` 时读取 wiring，所以需要 SettingsPanel
 * 顶层的"应用并重建 Agent"按钮才能真正让新 key 生效（Re-planned 中已说明）。
 *
 * 安全 / UX 备注：
 * - Electron contextBridge 已隔离渲染端 process，apiKey 不会写到 DOM 持久属性外
 * - 默认隐藏；用户点击眼睛才显示，避免共享屏幕时泄漏
 * - 空字符串和 null 视为"未配置"，保存前 trim
 */

import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Button } from "@/renderer/src/components/ui/button";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useStoreValue } from "@/renderer/src/hooks/use-store";

export function ApiKeyInput() {
  const { value: stored, loading, update } = useStoreValue<string | null>("apiKey", null);
  // 本地草稿：用户输入时不立即写盘，失焦或显式保存时才落盘，避免每键写一次 IPC
  const [draft, setDraft] = useState<string>(stored ?? "");
  const [show, setShow] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // store 加载完成后同步草稿（首次或外部变更）
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
          <KeyRound className="h-3.5 w-3.5" />
          API Key
        </Label>
        {!loading && (
          stored && stored.length > 0 ? (
            <Badge variant="secondary">已配置</Badge>
          ) : (
            <Badge variant="destructive">未配置</Badge>
          )
        )}
        {dirty && <Badge variant="outline">未保存</Badge>}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            placeholder="sk-..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              // 失焦自动保存非空 / 与已存值不同的草稿，体验更接近"实时写盘"
              if (dirty) void handleSave();
            }}
            disabled={loading}
            className="pr-9 font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "隐藏 API Key" : "显示 API Key"}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button variant="outline" size="sm" disabled={loading || !dirty} onClick={() => void handleSave()}>
          保存
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        OpenAI 兼容服务的 API Key。变更下次创建 Agent 时生效——可通过底部"应用并重建 Agent"立即生效。
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
