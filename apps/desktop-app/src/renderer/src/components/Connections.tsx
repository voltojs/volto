import { useEffect, useState } from "react";
import { Check, Pencil, Plus, RotateCw, Trash2, X } from "lucide-react";

import type { ProfileDraft, PublicGatewayProfile, ShellState } from "@shared/gateway";

import { Button } from "@/renderer/src/components/ui/button";
import { ProfileForm } from "@/renderer/src/components/ProfileForm";
import { StatusBadge } from "@/renderer/src/components/StatusBadge";
import { cn } from "@/renderer/src/lib/utils";

const STATUS_LABEL: Record<ShellState["status"]["state"], string> = {
  idle: "待连接",
  starting: "连接中…",
  online: "已连接",
  offline: "未连接",
};

function publicUrl(profile: PublicGatewayProfile): string {
  if (profile.kind === "local" && profile.managed) return "由应用启动 · 自动分配端口";
  return profile.url;
}

function draftOf(profile: PublicGatewayProfile): ProfileDraft {
  return {
    id: profile.id,
    label: profile.label,
    kind: profile.kind,
    url: profile.url,
    managed: profile.managed,
    token: "",
  };
}

export function Connections({ state }: { state: ShellState }) {
  const api = window.voltoShell;
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || editing !== null) return;
      void api.closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, editing]);

  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  const activeLabel = active?.label ?? "网关";
  const canDelete = state.profiles.length > 1;

  const switchTo = async (id: string): Promise<void> => {
    setActionError(null);
    await api.switchProfile(id);
  };

  const remove = async (id: string): Promise<void> => {
    const result = await api.removeProfile(id);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setPendingDelete(null);
  };

  return (
    <section className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">网关设置</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              主窗口始终显示当前网关自己的界面；切换后主窗口立即重载。
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭窗口"
            title="关闭窗口（Esc）"
            onClick={() => void api.closeSettings()}
          >
            <X className="size-4" />
          </Button>
        </div>

        {state.status.state === "offline" ? (
          <div
            role="alert"
            className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
          >
            <div className="text-sm font-medium text-destructive">无法连接「{activeLabel}」</div>
            <div className="mt-1 text-sm text-destructive/90">{state.status.error}</div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => {
                setActionError(null);
                void api.retry();
              }}
            >
              重试
            </Button>
          </div>
        ) : null}

        {state.status.degraded === true && state.status.detail !== undefined ? (
          <div className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            {state.status.detail}
          </div>
        ) : null}

        {actionError !== null ? (
          <div className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {actionError}
          </div>
        ) : null}

        {editing !== null ? (
          <div className="mt-5">
            <ProfileForm
              initial={editing}
              hasSavedToken={
                state.profiles.find((profile) => profile.id === editing.id)?.hasToken ?? false
              }
              onCancel={() => setEditing(null)}
              onSaved={() => setEditing(null)}
            />
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-sm font-medium">网关列表</h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setActionError(null);
              setEditing({ label: "", kind: "local", url: "", managed: true, token: "" });
            }}
          >
            <Plus className="size-4" />
            添加网关
          </Button>
        </div>

        <ul className="mt-3 space-y-2">
          {state.profiles.map((profile) => {
            const isActive = profile.id === state.activeProfileId;
            const status = isActive ? state.status : undefined;
            return (
              <li
                key={profile.id}
                className={cn(
                  "rounded-lg border px-4 py-3.5",
                  isActive ? "border-primary/40 bg-card" : "border-border bg-card/50",
                )}
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    aria-label={`切换到 ${profile.label}`}
                    onClick={() => void switchTo(profile.id)}
                    className={cn(
                      "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border",
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-transparent hover:border-primary/60",
                    )}
                  >
                    <Check className="size-3" />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{profile.label}</span>
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {profile.kind === "local" ? "本机" : "远程"}
                      </span>
                      {profile.hasToken ? (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          已保存令牌
                        </span>
                      ) : null}
                      {status !== undefined ? (
                        <StatusBadge
                          state={status.state}
                          label={
                            status.state === "online" && status.version !== undefined
                              ? `已连接 · v${status.version}`
                              : STATUS_LABEL[status.state]
                          }
                        />
                      ) : null}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {isActive && state.status.url !== undefined
                        ? state.status.url
                        : publicUrl(profile)}
                    </div>
                    {isActive && state.status.state === "starting" && state.status.detail !== undefined ? (
                      <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                        {state.status.detail}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {isActive ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={state.status.state === "starting"}
                        onClick={() => {
                          setActionError(null);
                          void api.restart();
                        }}
                      >
                        <RotateCw className="size-3.5" />
                        重连
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void switchTo(profile.id)}
                      >
                        切换
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`编辑 ${profile.label}`}
                      title="编辑"
                      onClick={() => {
                        setActionError(null);
                        setEditing(draftOf(profile));
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    {pendingDelete === profile.id ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => void remove(profile.id)}
                        >
                          确认删除
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="取消删除"
                          onClick={() => setPendingDelete(null)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除 ${profile.label}`}
                        title={canDelete ? "删除" : "至少保留一个网关"}
                        disabled={!canDelete}
                        onClick={() => setPendingDelete(profile.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 space-y-1.5 border-t border-border pt-4 text-xs text-muted-foreground">
          <p>
            远程网关的访问令牌在网关机器上运行 <code className="rounded bg-secondary px-1 py-0.5">volto token</code> 获取。
          </p>
          <p>
            本机网关与终端里的 <code className="rounded bg-secondary px-1 py-0.5">volto</code> 共用{" "}
            <code className="rounded bg-secondary px-1 py-0.5">~/.volto</code>
            （供应商、工作区、会话都在那里）。
          </p>
          <p>切换网关只会重载主窗口；未完成的对话留在各自网关的会话里，不会丢失。</p>
        </div>
      </div>
    </section>
  );
}