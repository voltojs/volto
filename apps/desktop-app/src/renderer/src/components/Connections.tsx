import { useEffect, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, RotateCw, Trash2, X } from "lucide-react";

import type { ProfileDraft, PublicGatewayProfile, ShellState } from "@shared/gateway";

import { Button } from "@/renderer/src/components/ui/button";
import { ProfileForm } from "@/renderer/src/components/ProfileForm";
import { StatusBadge } from "@/renderer/src/components/StatusBadge";
import { format, messages } from "@/renderer/src/lib/i18n";
import { cn } from "@/renderer/src/lib/utils";

function publicUrl(profile: PublicGatewayProfile, autoPort: string): string {
  if (profile.kind === "local" && profile.managed) return autoPort;
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
  const t = messages(state.locale);
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || editing !== null) return;
      void api.closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, editing]);

  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  const activeLabel = active?.label ?? "Gateway";
  const canDelete = state.profiles.length > 1;

  const statusLabel = (status: ShellState["status"]): string => {
    if (status.state === "online" && status.version !== undefined) {
      return format(t.connectedVersion, { version: status.version });
    }
    return t[status.state];
  };

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
            <h1 className="text-lg font-semibold">{t.settingsTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t.settingsSubtitle}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t.closeWindow}
            title={t.closeWindowHint}
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
            <div className="text-sm font-medium text-destructive">
              {format(t.cannotConnect, { label: activeLabel })}
            </div>
            <div className="mt-1 text-sm text-destructive/90">{state.status.error}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setActionError(null);
                  void api.retry();
                }}
              >
                {t.retry}
              </Button>
              {active?.kind === "local" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void api.openInstallDocs()}
                >
                  {t.installDocs}
                </Button>
              ) : null}
            </div>
            {active?.kind === "local" ? (
              <p className="mt-2 text-xs text-destructive/80">{t.installHint}</p>
            ) : null}
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
              locale={state.locale}
              hasSavedToken={
                state.profiles.find((profile) => profile.id === editing.id)?.hasToken ?? false
              }
              onCancel={() => setEditing(null)}
              onSaved={() => setEditing(null)}
            />
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-sm font-medium">{t.gatewayList}</h2>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={scanning}
              onClick={async () => {
                setActionError(null);
                setScanning(true);
                try {
                  const result = await api.scanLocal();
                  if (!result.ok) setActionError(result.error);
                } finally {
                  setScanning(false);
                }
              }}
            >
              <RefreshCw className={cn("size-4", scanning && "animate-spin")} />
              {t.scanLocal}
            </Button>
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
              {t.addGateway}
            </Button>
          </div>
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
                    aria-label={format(t.switchToProfile, { label: profile.label })}
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
                        {profile.kind === "local" ? t.kindLocal : t.kindRemote}
                      </span>
                      {profile.hasToken ? (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {t.savedToken}
                        </span>
                      ) : null}
                      {status !== undefined ? (
                        <StatusBadge state={status.state} label={statusLabel(status)} />
                      ) : null}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {isActive && state.status.url !== undefined
                        ? state.status.url
                        : publicUrl(profile, t.autoPort)}
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
                        {t.reconnect}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void switchTo(profile.id)}
                      >
                        {t.switch}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={format(t.editProfile, { label: profile.label })}
                      title={t.edit}
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
                          {t.confirmDelete}
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t.cancelDelete}
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
                        aria-label={format(t.deleteProfile, { label: profile.label })}
                        title={canDelete ? t.delete : t.atLeastOne}
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
            {t.noteToken}{" "}
            <code className="rounded bg-secondary px-1 py-0.5">volto token</code>
            {t.noteTokenTail}
          </p>
          <p>
            {t.noteShared}{" "}
            <code className="rounded bg-secondary px-1 py-0.5">volto</code>{" "}
            {t.noteSharedMiddle}{" "}
            <code className="rounded bg-secondary px-1 py-0.5">~/.volto</code>
            {t.noteSharedTail}
          </p>
          <p>{t.noteSwitch}</p>
        </div>
      </div>
    </section>
  );
}
