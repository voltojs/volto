import { useEffect, useState } from "react";

import type { ProfileDraft } from "@shared/gateway";
import { normalizeProfileDraft } from "@shared/profiles";

import { Button } from "@/renderer/src/components/ui/button";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Switch } from "@/renderer/src/components/ui/switch";
import { cn } from "@/renderer/src/lib/utils";

export interface ProfileFormProps {
  initial: ProfileDraft;
  hasSavedToken: boolean;
  onCancel(): void;
  onSaved(): void;
}

/** Form state is the draft plus the two flags the input boxes need. */
export function ProfileForm(props: ProfileFormProps) {
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
    const normalized = normalizeProfileDraft(draft);
    if (!normalized.ok) {
      setError(normalized.error);
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

  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{props.initial.id === undefined ? "添加网关" : "编辑网关"}</h2>
        <div className="inline-flex rounded-md border border-border p-0.5">
          {(["local", "remote"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() =>
                update({
                  kind,
                  managed: kind === "local" ? true : false,
                })
              }
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                draft.kind === kind
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {kind === "local" ? "本机" : "远程"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-label">名称</Label>
        <Input
          id="profile-label"
          value={draft.label}
          maxLength={60}
          placeholder={isRemote ? "公司构建机" : "本机网关"}
          onChange={(event) => update({ label: event.target.value })}
        />
      </div>

      {isRemote ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="profile-url">网关地址</Label>
            <Input
              id="profile-url"
              value={draft.url ?? ""}
              placeholder="https://gateway.example.com"
              onChange={(event) => update({ url: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              填到端口即可，不要带路径；协议默认 http。
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-token">访问令牌</Label>
            <Input
              id="profile-token"
              type="password"
              value={draft.token ?? ""}
              placeholder={props.hasSavedToken ? "已保存（留空则不修改）" : "在网关机器上运行 volto token 获取"}
              onChange={(event) => update({ token: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              令牌只交给主进程保存，不会出现在页面或日志里。
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
            <div>
              <div className="text-sm">由应用启动</div>
              <div className="text-xs text-muted-foreground">
                关闭后连接到已在运行的本机网关。
              </div>
            </div>
            <Switch
              checked={managed}
              onCheckedChange={(checked) => update({ managed: checked })}
              aria-label="由应用启动"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-local-url">
              {managed ? "地址（可选，留空自动分配端口）" : "地址"}
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

      {error !== null ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}