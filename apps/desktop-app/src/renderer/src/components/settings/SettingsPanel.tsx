/**
 * SettingsPanel
 * 应用设置面板：Tabs 切"通用"（模型 + API Key）和"权限"（PermissionEditor 复用）。
 *
 * 底部一个"应用并重建 Agent"按钮：调 agent:create 让 wiring 重新读取 store，
 * 让运行中的 agent 实例真正吃到刚改的 modelName / apiKey / permissionMode。
 *
 * 设计：
 * - 不引入独立 settings-store —— 所有字段直接走 useStoreValue 单一 source
 * - 重建按钮的成功 / 失败用 inline 文字 + Badge 反馈，避免引入 toast 依赖
 * - 整个面板被外部 Dialog 包裹（Sidebar 控制 open）；面板自身不做模态控制
 */

import { useState } from "react";
import { RotateCw, CheckCircle2, AlertCircle } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/renderer/src/components/ui/tabs";
import { Button } from "@/renderer/src/components/ui/button";
import { Separator } from "@/renderer/src/components/ui/separator";
import { ApiKeyInput } from "./ApiKeyInput";
import { ModelSelector } from "./ModelSelector";
import { PermissionEditor } from "@/renderer/src/components/approval/PermissionEditor";

type RecreateState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function SettingsPanel() {
  const [state, setState] = useState<RecreateState>({ kind: "idle" });

  const handleRecreate = async () => {
    const api = window.electronAPI?.agent;
    if (!api) {
      setState({ kind: "error", message: "Electron API 不可用" });
      return;
    }
    setState({ kind: "pending" });
    try {
      const result = await api.create();
      if (result.success) {
        setState({ kind: "ok" });
      } else {
        setState({ kind: "error", message: result.error ?? "Agent 创建失败" });
      }
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">通用</TabsTrigger>
          <TabsTrigger value="permission">权限</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-5 pt-3">
          <ModelSelector />
          <Separator />
          <ApiKeyInput />
        </TabsContent>

        <TabsContent value="permission" className="pt-3">
          {/* 复用 Phase 5 编辑器；showRestartHint=false 因为这里有显式重建按钮 */}
          <PermissionEditor showRestartHint={false} />
        </TabsContent>
      </Tabs>

      <Separator />

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground flex-1">
          配置变更立即写入 electron-store；但 Agent 实例在创建时一次性读取，
          需要"应用并重建 Agent"让新值生效。
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleRecreate()}
          disabled={state.kind === "pending"}
          className="shrink-0"
        >
          <RotateCw className="h-3.5 w-3.5 mr-1" />
          应用并重建 Agent
        </Button>
      </div>

      {state.kind === "ok" && (
        <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Agent 已使用新配置重建
        </div>
      )}
      {state.kind === "error" && (
        <div className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          重建失败：{state.message}
        </div>
      )}
    </div>
  );
}
