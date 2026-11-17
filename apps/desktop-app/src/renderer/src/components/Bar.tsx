import type { ReactNode } from "react";
import { ChevronDown, ExternalLink, RotateCw, Settings2 } from "lucide-react";

import type { GatewayState, ShellState } from "@shared/gateway";

import { cn } from "@/renderer/src/lib/utils";

const DOT_CLASS: Record<GatewayState, string> = {
  idle: "bg-zinc-400",
  starting: "animate-pulse bg-amber-500",
  online: "bg-emerald-500",
  offline: "bg-red-500",
};

export function statusText(state: ShellState): string {
  switch (state.status.state) {
    case "online": {
      const version = state.status.version !== undefined ? ` · v${state.status.version}` : "";
      const mode = state.status.mode === "remote" ? " · 远程" : "";
      return `已连接${version}${mode}`;
    }
    case "starting":
      return state.status.detail ?? "正在启动…";
    case "offline":
      return "未连接";
    default:
      return "准备中…";
  }
}

function BarButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="no-drag inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {props.children}
    </button>
  );
}

export function Bar({ state }: { state: ShellState }) {
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  const online = state.status.state === "online";
  const api = window.voltoShell;

  return (
    <header
      className={cn(
        "drag-region flex h-11 shrink-0 select-none items-center gap-2 border-b border-border bg-background pl-3 pr-2",
        state.platform === "darwin" && "pl-[78px]",
        state.platform === "win32" && "pr-[140px]",
      )}
    >
      <button
        type="button"
        onClick={() => void api.setSheetOpen(true)}
        className="no-drag flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
      >
        <span className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state.status.state])} />
        <span className="truncate text-sm font-medium">{active?.label ?? "Volto"}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          {statusText(state)}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      <div className="no-drag ml-auto flex items-center gap-1">
        <BarButton
          label={online ? "重新加载界面" : "重试连接"}
          onClick={() => void (online ? api.reload() : api.retry())}
        >
          <RotateCw className="size-4" />
        </BarButton>
        <BarButton label="在浏览器中打开" disabled={!online} onClick={() => void api.openInBrowser()}>
          <ExternalLink className="size-4" />
        </BarButton>
        <BarButton label="管理网关" onClick={() => void api.setSheetOpen(true)}>
          <Settings2 className="size-4" />
        </BarButton>
      </div>
    </header>
  );
}