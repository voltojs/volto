/**
 * ReplayControls
 * 客户端事件流时间轴控制器：拖动 slider / 单步前进/后退 / 重置到实时。
 *
 * 重要：本组件只控制 **debug-store.cursor**，不真正 pause / step agent 主循环。
 * SDK 不暴露调度 hook，agent 一旦 run 起来就会一直跑到 model_done 或被 cancel；
 * 这里仅截取已发生事件的视图，便于事后调试。
 */

import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { Button } from "@/renderer/src/components/ui/button";
import { Slider } from "@/renderer/src/components/ui/slider";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useDebugStore } from "@/renderer/src/stores/debug-store";
import { useDebug } from "@/renderer/src/hooks/use-debug";

export function ReplayControls() {
  const total = useDebugStore((s) => s.events.length);
  const cursor = useDebugStore((s) => s.cursor);
  const isReplaying = useDebugStore((s) => s.isReplaying);
  const { setCursor, step, resumeLive, clear } = useDebug();

  const disabled = total === 0;

  return (
    <div className="flex items-center gap-2 px-2 py-1 border rounded-md bg-muted/30">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={() => setCursor(0)}
        aria-label="跳到开头"
        title="跳到开头"
      >
        <SkipBack className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled || cursor === 0}
        onClick={() => step(-1)}
        aria-label="后退一步"
        title="后退一步"
      >
        <Pause className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled || cursor >= total}
        onClick={() => step(1)}
        aria-label="前进一步"
        title="前进一步"
      >
        <Play className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled || !isReplaying}
        onClick={() => resumeLive()}
        aria-label="跟随实时"
        title="跟随实时"
      >
        <SkipForward className="h-3.5 w-3.5" />
      </Button>

      <div className="flex-1 px-2">
        <Slider
          value={[cursor]}
          min={0}
          max={Math.max(1, total)}
          step={1}
          onValueChange={([v]) => setCursor(v ?? 0)}
          disabled={disabled}
          aria-label="时间轴游标"
        />
      </div>

      <div className="flex items-center gap-1 shrink-0 text-xs text-muted-foreground font-mono">
        <span>
          {cursor}/{total}
        </span>
        {isReplaying ? (
          <Badge variant="destructive" className="ml-1">
            回放
          </Badge>
        ) : (
          <Badge variant="secondary" className="ml-1">
            实时
          </Badge>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={() => clear()}
        aria-label="清空调试历史"
        title="清空调试历史"
      >
        <Square className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
