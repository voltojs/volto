import { useEffect, useState } from "react";

import type { ProfileDraft, ShellLocale } from "@shared/gateway";

import { Button } from "@/renderer/src/components/ui/button";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Switch } from "@/renderer/src/components/ui/switch";
import { messages } from "@/renderer/src/lib/i18n";
import { cn } from "@/renderer/src/lib/utils";

export interface ProfileFormProps {
  initial: ProfileDraft;
  locale: ShellLocale;
  hasSavedToken: boolean;
  onCancel(): void;
  onSaved(): void;
}

/** Form state is the draft plus the two flags the input boxes need. */
export function ProfileForm(props: ProfileFormProps) {
  const t = messages(props.locale);
  const [draft, setDraft] = useState<ProfileDraft>({
    ...props.initial,
    token: props.initial.token ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft({ ...props.initial, token: props.initial.token ?? "" });
  }, [props.initial]);

  const update = (patch: Partial<ProfileDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (draft.label.trim() === "") {
      setError(t.errorName);
      return;
    }
    const needsUrl = draft.kind === "remote" || draft.managed === false;
    if (needsUrl && (draft.url ?? "").trim() === "") {
      setError(t.errorUrl);
      return;
    }
    setBusy(true);
    try {
      const result = await window.voltoShell.saveProfile(draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      props.onSaved();
    } finally {
      setBusy(false);
    }
  };

  const isRemote = draft.kind === "remote";
  const managed = draft.managed !== false;
  // A gateway the app did not start still needs its access token; only the
  // managed local process hands us a fresh one on every launch.
  const needsToken = isRemote || !managed;

  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {props.initial.id === undefined ? t.formAdd : t.formEdit}
        </h2>
        <div className="inline-flex rounded-md border border-border p-0.5">
          {(["local", "remote"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() =>
                update({
                  kind,
                  managed: kind === "local",
                })
              }
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                draft.kind === kind
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {kind === "local" ? t.kindLocal : t.kindRemote}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-label">{t.name}</Label>
        <Input
          id="profile-label"
          value={draft.label}
          maxLength={60}
          placeholder={isRemote ? t.namePlaceholderRemote : t.namePlaceholderLocal}
          onChange={(event) => update({ label: event.target.value })}
        />
      </div>

      {isRemote ? (
        <div className="space-y-1.5">
          <Label htmlFor="profile-url">{t.gatewayUrl}</Label>
          <Input
            id="profile-url"
            value={draft.url ?? ""}
            placeholder="https://gateway.example.com"
            onChange={(event) => update({ url: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t.gatewayUrlHint}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
            <div>
              <div className="text-sm">{t.launchedByApp}</div>
              <div className="text-xs text-muted-foreground">{t.launchedByAppHint}</div>
            </div>
            <Switch
              checked={managed}
              onCheckedChange={(checked) => update({ managed: checked })}
              aria-label={t.launchedByApp}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-local-url">
              {managed ? t.addressOptional : t.address}
            </Label>
            <Input
              id="profile-local-url"
              value={draft.url ?? ""}
              placeholder="http://127.0.0.1:3100"
              onChange={(event) => update({ url: event.target.value })}
            />
          </div>
        </>
      )}

      {needsToken ? (
        <div className="space-y-1.5">
          <Label htmlFor="profile-token">{t.token}</Label>
          <Input
            id="profile-token"
            type="password"
            value={draft.token ?? ""}
            placeholder={
              props.hasSavedToken ? t.tokenSavedPlaceholder : t.tokenEmptyPlaceholder
            }
            onChange={(event) => update({ token: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t.tokenHint}</p>
        </div>
      ) : null}

      {error !== null ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t.saving : t.save}
        </Button>
      </div>
    </form>
  );
}
