/**
 * SettingsPanel
 * 应用设置面板：Tabs 切"模型"（供应商/模型 CRUD）和"权限"（PermissionEditor 复用）。
 *
 * 模型切换不再需要这里的全局重建按钮——对话页选择模型后立即对该会话
 * 自动重建 Agent 实例（见 SessionModelPicker）。
 */

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/renderer/src/components/ui/tabs";
import { ProvidersPanel } from "./ProvidersPanel";
import { PermissionEditor } from "@/renderer/src/components/approval/PermissionEditor";

export function SettingsPanel() {
  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">模型</TabsTrigger>
          <TabsTrigger value="permission">权限</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-3 pt-3">
          <ProvidersPanel />
        </TabsContent>

        <TabsContent value="permission" className="pt-3">
          <PermissionEditor showRestartHint={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
