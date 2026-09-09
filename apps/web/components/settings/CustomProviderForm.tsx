'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { ProviderShell } from './ProviderShell';
import { ModelTable, toDraftModels, type DraftModel } from './ModelTable';

/** 自定义 Provider 区块：现有的“新增供应商”入口 + 各自定义 provider 的折叠行。 */
export function CustomProviderSection({ providers }: { providers: Provider[] }) {
  const addProvider = useConfigStore((s) => s.addProvider);
  const [error, setError] = useState<string | null>(null);
  /** Id of the provider just created, so it opens straight into its form. */
  const [openId, setOpenId] = useState<string | null>(null);

  const handleAdd = async () => {
    setError(null);
    try {
      const created = await addProvider({
        kind: 'custom',
        name: '新供应商',
        baseURL: null,
        apiKey: null,
        models: [],
      });
      // A brand-new provider is empty by definition — collapsing it would
      // hide the only thing the user came here to do.
      if (created) setOpenId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增供应商失败');
    }
  };

  const customProviders = providers.filter(
    (p): p is Extract<Provider, { kind: 'custom' }> => p.kind === 'custom',
  );

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
        自定义 Provider
      </div>

      {customProviders.map((provider) => (
        <CustomProviderCard
          key={provider.id}
          provider={provider}
          expanded={openId === provider.id}
          onToggle={() =>
            setOpenId((current) =>
              current === provider.id ? null : provider.id,
            )
          }
        />
      ))}
      {customProviders.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
          还没有配置自定义供应商
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Button
        variant="outline"
        className="w-full gap-2 border-dashed"
        onClick={() => void handleAdd()}
      >
        <Plus className="h-4 w-4" />
        新增自定义 Provider
      </Button>
    </div>
  );
}

/** One custom provider with an editable draft; changes are saved explicitly. */
function CustomProviderCard({
  provider,
  expanded,
  onToggle,
}: {
  provider: Extract<Provider, { kind: 'custom' }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const editProvider = useConfigStore((s) => s.editProvider);
  const removeProvider = useConfigStore((s) => s.removeProvider);

  const [name, setName] = useState(provider.name);
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<DraftModel[]>(() =>
    toDraftModels(provider.models),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the user has touched this draft since it was last synced
  // with the server. `useState` only seeds from `provider` on mount, so
  // without this an external refresh (e.g. the sidebar's `load()`) would
  // never be reflected — but re-syncing unconditionally would blow away
  // whatever the user is mid-typing. We only re-seed while untouched.
  const [dirty, setDirty] = useState(false);
  // "Adjusting state when a prop changes" (see react.dev): comparing against
  // the previous render and calling setState directly in the render body —
  // rather than in a useEffect — avoids an extra commit/paint cycle.
  const [syncedProvider, setSyncedProvider] = useState(provider);
  if (provider !== syncedProvider && !dirty) {
    setSyncedProvider(provider);
    setName(provider.name);
    setBaseURL(provider.baseURL ?? '');
    setModels(toDraftModels(provider.models));
  }

  const remove = async () => {
    setError(null);
    try {
      await removeProvider(provider.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除供应商失败');
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await editProvider(provider.id, {
        kind: 'custom',
        name,
        baseURL: baseURL.trim() || null,
        // Empty means "leave the stored key alone" — the server treats an
        // omitted apiKey as unchanged.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          code: m.code,
          ...(m.contextWindow === undefined
            ? {}
            : { contextWindow: m.contextWindow }),
          ...(m.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: m.maxOutputTokens }),
          reasoning: m.reasoning,
        })),
      });
      setApiKey('');
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProviderShell
      // The collapsed row shows the saved name, not the draft: it is the
      // provider's identity, and showing a half-typed rename in the header of
      // a form the user may still cancel out of would be a lie.
      name={provider.name}
      badges={
        <>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            {provider.models.length} 个模型
          </Badge>
          {provider.apiKeyMasked && (
            <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
              {provider.apiKeyMasked}
            </Badge>
          )}
        </>
      }
      expanded={expanded}
      onToggle={onToggle}
      onRemove={() => void remove()}
    >
      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">名称</span>
          <Input
            className="h-8"
            value={name}
            onChange={(e) => {
              setDirty(true);
              setName(e.target.value);
            }}
            placeholder="供应商名称"
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">baseURL</span>
          <Input
            className="h-8 font-mono text-xs"
            value={baseURL}
            onChange={(e) => {
              setDirty(true);
              setBaseURL(e.target.value);
            }}
            placeholder="留空使用默认地址"
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">apiKey</span>
          <Input
            className="h-8 font-mono text-xs"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setDirty(true);
              setApiKey(e.target.value);
            }}
            placeholder={
              provider.apiKeyMasked ? '留空则不修改' : 'apiKey'
            }
          />
        </label>
      </div>

      <ModelTable
        models={models}
        onChange={(next) => {
          setDirty(true);
          setModels(next);
        }}
      />

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Button
        size="sm"
        onClick={() => void save()}
        disabled={saving}
        className="w-full"
      >
        {saving ? '保存中…' : '保存'}
      </Button>
    </ProviderShell>
  );
}
