/**
 * DebugPanel
 * 调试视图总入口 — Sheet 侧拉抽屉，顶部 ReplayControls，下方 Tabs 切换 4 个子面板。
 *
 * 设计：
 * - 用 Sheet 而非 Dialog，避免遮挡主对话；side="right" 让用户对照看
 * - 4 个 tab 共享同一份 debug-store 视图（cursor / filter）
 * - 该组件由 Sidebar 的 Bug 按钮 open 控制
 */

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/renderer/src/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/renderer/src/components/ui/tabs";
import { ReplayControls } from "./ReplayControls";
import { StateInspector } from "./StateInspector";
import { EventTimeline } from "./EventTimeline";
import { ToolTracer } from "./ToolTracer";
import { LogViewer } from "./LogViewer";

export interface DebugPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DebugPanel({ open, onOpenChange }: DebugPanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(720px,95vw)] sm:max-w-none flex flex-col gap-3 p-4"
      >
        <SheetHeader>
          <SheetTitle>调试面板</SheetTitle>
          <SheetDescription>
            实时 EventSink 事件流 / 客户端时间轴回放 / 工具调用追踪 / state 检视
          </SheetDescription>
        </SheetHeader>

        <ReplayControls />

        <Tabs defaultValue="timeline" className="flex-1 min-h-0">
          <TabsList>
            <TabsTrigger value="timeline">事件时间轴</TabsTrigger>
            <TabsTrigger value="tools">工具追踪</TabsTrigger>
            <TabsTrigger value="state">State 检视</TabsTrigger>
            <TabsTrigger value="logs">日志</TabsTrigger>
          </TabsList>

          <TabsContent value="timeline" className="flex-1 min-h-0 overflow-auto pt-2">
            <EventTimeline />
          </TabsContent>
          <TabsContent value="tools" className="flex-1 min-h-0 overflow-auto pt-2">
            <ToolTracer />
          </TabsContent>
          <TabsContent value="state" className="flex-1 min-h-0 overflow-hidden pt-2">
            <StateInspector />
          </TabsContent>
          <TabsContent value="logs" className="flex-1 min-h-0 overflow-hidden pt-2">
            <LogViewer />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
