/**
 * ApprovalDialog
 * 当主进程 ApprovalGate 推来一条审批请求时弹出全局确认弹窗。
 * 由 `useApproval` 维护队列，弹窗只渲染队首请求；用户做出决策后写回主进程。
 *
 * 设计：使用 shadcn AlertDialog（非可关闭，必须 allow / deny 才会消失）以避免
 * 用户绕过审批；底层主进程的超时机制是兜底，但不应该是 UI 的逃生口。
 */

import { useApproval, type ApprovalRequest } from "@/renderer/src/hooks/use-approval";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/renderer/src/components/ui/alert-dialog";
import { Badge } from "@/renderer/src/components/ui/badge";
import { buttonVariants } from "@/renderer/src/components/ui/button";
import { cn } from "@/renderer/src/lib/utils";

/** 把风险等级转成 Badge 颜色和文案 */
function riskBadge(tier: ApprovalRequest["riskTier"]) {
  switch (tier) {
    case "READ_ONLY":
      return { label: "只读", variant: "secondary" as const };
    case "WRITE_LOW":
      return { label: "低风险写", variant: "secondary" as const };
    case "WRITE_HIGH":
      return { label: "高风险写", variant: "destructive" as const };
    case "IRREVERSIBLE":
      return { label: "不可逆", variant: "destructive" as const };
    default:
      return { label: String(tier), variant: "secondary" as const };
  }
}

/** 把参数对象做一份可读的 JSON pretty-print，过长截断 */
function formatArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args, null, 2);
    return json.length > 4000 ? json.slice(0, 4000) + "\n... (truncated)" : json;
  } catch {
    return String(args);
  }
}

export function ApprovalDialog() {
  const { current, decide } = useApproval();
  const open = current !== null;

  if (!current) {
    // 即便不显示，也保留 AlertDialog open=false 一次以便 transition 干净
    return <AlertDialog open={false} />;
  }

  const badge = riskBadge(current.riskTier);

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            工具调用确认
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <div>
                Agent 正请求执行工具{" "}
                <span className="font-mono font-semibold">{current.toolName}</span>
                ，请确认是否允许。
              </div>
              <div className="text-xs text-muted-foreground">
                请求 ID: <span className="font-mono">{current.requestId}</span>
              </div>
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="text-xs font-medium text-muted-foreground mb-1">参数</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                  {formatArgs(current.args)}
                </pre>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          {/*
            两个按钮都用 AlertDialogAction（而非 AlertDialogCancel）：deny 是一个
            有语义的决定而非"关闭/取消"，用 destructive 样式表达严肃性，也让
            屏幕阅读器读出"拒绝"而不是"取消"。
          */}
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={() => void decide(current.requestId, "deny")}
          >
            拒绝
          </AlertDialogAction>
          <AlertDialogAction onClick={() => void decide(current.requestId, "allow")}>
            允许
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
