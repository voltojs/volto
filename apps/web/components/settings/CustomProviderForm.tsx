'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfigStore, type Provider } from '@/stores/config-store';
import type { ProviderAuth, ProviderProtocol } from '@/lib/config-api';
import { ProviderShell } from './ProviderShell';
import { ModelTable, toDraftModels, type DraftModel } from './ModelTable';

/** 自定义 Provider 区块：现有的“新增供应商”入口 + 各自定义 provider 的折叠行。 */
export function CustomProviderSection({ providers }: { providers: Provider[] }) {
  const t = useTranslations('settings');
  const addProvider = useConfigStore((s) => s.addProvider);
  const [error, setError] = useState<string | null>(null);
  /** Id of the provider just created, so it opens straight into its form. */
  const [openId, setOpenId] = useState<string | null>(null);

  const handleAdd = async () => {
    setError(null);
    try {
      const created = await addProvider({
        kind: 'custom',
        name: t('providers.customNameDefault'),
        baseURL: null,
        apiKey: null,
        models: [],
      });
      // A brand-new provider is empty by definition — collapsing it would
      // hide the only thing the user came here to do.
      if (created) setOpenId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  const customProviders = providers.filter(
    (p): p is Extract<Provider, { kind: 'custom' }> => p.kind === 'custom',
  );

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
        {t('providers.custom')}
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
          {t('providers.customEmpty')}
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Button
        variant="outline"
        className="w-full gap-2 border-dashed"
        onClick={() => void handleAdd()}
      >
        <Plus className="h-4 w-4" />
        {t('providers.customAdd')}
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
  const t = useTranslations('settings');
  const editProvider = useConfigStore((s) => s.editProvider);
  const removeProvider = useConfigStore((s) => s.removeProvider);

  const [name, setName] = useState(provider.name);
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ProviderProtocol>(
    provider.protocol ?? 'openai-completions',
  );
  const [authKind, setAuthKind] = useState<ProviderAuth['kind']>(
    provider.auth?.kind ?? 'bearer',
  );
  const [authHeaderName, setAuthHeaderName] = useState(
    provider.auth?.kind === 'header' ? provider.auth.name : '',
  );
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
    setProtocol(provider.protocol ?? 'openai-completions');
    setAuthKind(provider.auth?.kind ?? 'bearer');
    setAuthHeaderName(provider.auth?.kind === 'header' ? provider.auth.name : '');
    setModels(toDraftModels(provider.models));
  }

  const remove = async () => {
    setError(null);
    try {
      await removeProvider(provider.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.deleteFailed'));
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
        protocol,
        auth: authKind === 'header'
          ? { kind: 'header', name: authHeaderName.trim() }
          : { kind: authKind },
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
          ...(m.input === undefined ? {} : { input: m.input }),
        })),
      });
      setApiKey('');
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.saveFailed'));
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
            {t('providers.modelCount', { count: provider.models.length })}
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
          <span className="text-muted-foreground text-[11px]">{t('providers.name')}</span>
          <Input
            className="h-8"
            value={name}
            onChange={(e) => {
              setDirty(true);
              setName(e.target.value);
            }}
            placeholder={t('providers.namePlaceholder')}
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
            placeholder={t('providers.baseUrlDefault')}
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
              provider.apiKeyMasked ? t('providers.keyKeep') : t('providers.apiKey')
            }
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-muted-foreground text-[11px]">{t('providers.protocol')}</span>
        <select
          className="border-input bg-background h-8 w-full rounded-md border px-2 font-mono text-xs"
          value={protocol}
          onChange={(e) => {
            setDirty(true);
            setProtocol(e.target.value as ProviderProtocol);
          }}
        >
          <option value="openai-completions">{t('providers.protocolOpenAICompletions')}</option>
          <option value="openai-responses">{t('providers.protocolOpenAIResponses')}</option>
          <option value="anthropic-messages">{t('providers.protocolAnthropicMessages')}</option>
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-muted-foreground text-[11px]">{t('providers.auth')}</span>
          <select
            className="border-input bg-background h-8 w-full rounded-md border px-2 font-mono text-xs"
            value={authKind}
            onChange={(e) => {
              setDirty(true);
              setAuthKind(e.target.value as ProviderAuth['kind']);
            }}
          >
            <option value="bearer">{t('providers.authBearer')}</option>
            <option value="x-api-key">{t('providers.authXApiKey')}</option>
            <option value="header">{t('providers.authHeader')}</option>
          </select>
        </label>
        {authKind === 'header' && (
          <label className="block space-y-1">
            <span className="text-muted-foreground text-[11px]">{t('providers.authHeaderName')}</span>
            <Input
              className="h-8 font-mono text-xs"
              value={authHeaderName}
              onChange={(e) => {
                setDirty(true);
                setAuthHeaderName(e.target.value);
              }}
              placeholder="x-api-key"
            />
          </label>
        )}
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
        {saving ? t('providers.saving') : t('providers.save')}
      </Button>
    </ProviderShell>
  );
}
