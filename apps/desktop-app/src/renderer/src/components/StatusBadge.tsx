import { cn } from "@/renderer/src/lib/utils";
import type { GatewayState } from "@shared/gateway";

const TONE: Record<GatewayState, string> = {
  idle: "text-muted-foreground",
  starting: "text-amber-600 dark:text-amber-400",
  online: "text-emerald-600 dark:text-emerald-400",
  offline: "text-destructive",
};

const DOT: Record<GatewayState, string> = {
  idle: "bg-zinc-400",
  starting: "animate-pulse bg-amber-500",
  online: "bg-emerald-500",
  offline: "bg-red-500",
};

export function StatusBadge(props: { state: GatewayState; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", TONE[props.state])}>
      <span className={cn("size-1.5 rounded-full", DOT[props.state])} />
      {props.label}
    </span>
  );
}