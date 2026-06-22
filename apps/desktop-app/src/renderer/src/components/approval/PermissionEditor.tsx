/**
 * PermissionEditor（窄化版）
 * 当前 phase 仅做"全局权限模式"切换：auto / ask / deny。
 * 通过 use-store 写到 electron-store 的 `permissionMode` 字段，下次
 * `agent:create` 会读取生效；正在跑的 agent 需要重新创建才能切换模式。
 *
 * 后续 phase 会扩展为按工具 / 按 RiskTier 的可视化 rules 编辑器。
 */

import { useEffect, useState } from "react";
import { useStoreValue } from "@/renderer/src/hooks/use-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/renderer/src/components/ui/select";
import { Label } from "@/renderer/src/components/ui/label";

type Mode = "auto" | "ask" | "deny";

const MODE_OPTIONS: Array<{ value: Mode; label: string; hint: string }> = [
  { value: "auto", label: "自动允许", hint: "所有工具调用直接执行" },
  { value: "ask", label: "高风险询问", hint: "写入/不可逆操作弹窗确认" },
  { value: "deny", label: "全部拒绝", hint: "拒绝任何工具调用（只读模式）" },
];

interface Props {
  /** 修改后是否在标题旁显示"需要重启 agent"的提示；默认 true */
  showRestartHint?: boolean;
}

export function PermissionEditor({ showRestartHint = true }: Props) {
  const { value: mode, loading, update: setMode } = useStoreValue<Mode>(
    "permissionMode",
    "auto",
  );
  const [pristine, setPristine] = useState<Mode | null>(null);

  // 记录首次加载完成时的初始值，用于判断"已修改"
  useEffect(() => {
    if (!loading && pristine === null) {
      setPristine(mode);
    }
  }, [loading, mode, pristine]);

  const changed = pristine !== null && pristine !== mode;
  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">权限模式</Label>
        {showRestartHint && changed && (
          <span className="text-xs text-amber-600">需要重新创建 agent 生效</span>
        )}
      </div>

      <Select
        value={mode}
        onValueChange={(v) => void setMode(v as Mode)}
        disabled={loading}
      >
        <SelectTrigger className="w-72">
          <SelectValue placeholder="选择权限模式" />
        </SelectTrigger>
        <SelectContent>
          {MODE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <div className="flex flex-col text-left">
                <span>{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.hint}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-xs text-muted-foreground">
        当前：{current?.label ?? mode} — {current?.hint ?? ""}
      </p>
    </div>
  );
}
