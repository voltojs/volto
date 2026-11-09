'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { probeProvider, type ProviderAuth, type ProviderProtocol } from '@/lib/config-api';
import { ProviderShell } from './ProviderShell';
import { ModelTable, toDraftModels, type DraftModel } from './ModelTable';

/** 自定义 Provider 区块：现有的“新增供应商”入口 + 各自定义 provider 的折叠行。 */
export function CustomProviderSection({ providers }: { providers: Provider[] }) {
  const t = useTranslations('settings');
  const addProvider = useConfigStore((s) => s.addProvider);
  const [error, setError] = useState<string | null>(null);
  /** Id of the provider just created, so it opens straight into its form. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

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
      if (created) {
        setOpenId(created.id);
        setCreatedId(created.id);
      }
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
          defaultOpen={createdId === provider.id}
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
  defaultOpen,
  expanded,
  onToggle,
}: {
  provider: Extract<Provider, { kind: 'custom' }>;
  defaultOpen: boolean;
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
  const [authKind, setAuthKind] = useState<ProviderAuth['kind'] | 'auto'>(
    provider.auth?.kind ?? 'auto',
  );
  const [authHeaderName, setAuthHeaderName] = useState(
    provider.auth?.kind === 'header' ? provider.auth.name : '',
  );
  const [defaultsOpen, setDefaultsOpen] = useState(defaultOpen);
  const [models, setModels] = useState<DraftModel[]>(() =>
    toDraftModels(provider.models),
  );
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string | null>(null);
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
    setAuthKind(provider.auth?.kind ?? 'auto');
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

  const testRoute = async () => {
    setProbing(true);
    setProbeText(null);
    setError(null);
    try {
      const first = provider.models[0];
      if (!first) throw new Error(t('providers.routeFailed', { error: 'no model' }));
      const result = await probeProvider(provider.id, { modelId: first.id });
      setProbeText(result.ok
        ? t('providers.routeOk')
        : t('providers.routeFailed', { error: result.error ?? "probe failed" }));
    } catch (err) {
      setProbeText(t('providers.routeFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setProbing(false);
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
        auth: authKind === 'auto'
          ? null
          : authKind === 'header'
            ? { kind: 'header', name: authHeaderName.trim() }
            : { kind: authKind },
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          code: m.code,
          ...(m.protocol === undefined ? {} : { protocol: m.protocol }),
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
      <p className="text-muted-foreground text-xs">
        {t('providers.defaultsHint')}
      </p>

      <Collapsible
        open={defaultsOpen}
        onOpenChange={setDefaultsOpen}
        className="bg-muted/20 overflow-hidden rounded-lg border"
      >
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-between rounded-none px-3 py-2"
            />
          }
        >
          <span>{t('providers.defaultsTitle')}</span>
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>{t('providers.protocolDefault')} · {t('providers.auth')}</span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${defaultsOpen ? 'rotate-180' : ''}`}
            />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t px-3 py-3">
          <div className="space-y-3">
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
        <span className="text-muted-foreground text-[11px]">{t('providers.protocolDefault')}</span>
        <Select
          items={[
            { value: 'openai-completions', label: t('providers.protocolOpenAICompletions') },
            { value: 'openai-responses', label: t('providers.protocolOpenAIResponses') },
            { value: 'anthropic-messages', label: t('providers.protocolAnthropicMessages') },
          ]}
          value={protocol}
          onValueChange={(next) => {
            setDirty(true);
            setProtocol(String(next) as ProviderProtocol);
          }}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent width="content">
            <SelectItem value="openai-completions">{t('providers.protocolOpenAICompletions')}</SelectItem>
            <SelectItem value="openai-responses">{t('providers.protocolOpenAIResponses')}</SelectItem>
            <SelectItem value="anthropic-messages">{t('providers.protocolAnthropicMessages')}</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-muted-foreground text-[11px]">{t('providers.auth')}</span>
          <Select
            items={[
              { value: 'auto', label: t('providers.authAuto') },
              { value: 'bearer', label: t('providers.authBearer') },
              { value: 'x-api-key', label: t('providers.authXApiKey') },
              { value: 'header', label: t('providers.authHeader') },
            ]}
            value={authKind}
            onValueChange={(next) => {
              setDirty(true);
              setAuthKind(String(next) as ProviderAuth['kind'] | 'auto');
            }}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent width="content">
              <SelectItem value="auto">{t('providers.authAuto')}</SelectItem>
              <SelectItem value="bearer">{t('providers.authBearer')}</SelectItem>
              <SelectItem value="x-api-key">{t('providers.authXApiKey')}</SelectItem>
              <SelectItem value="header">{t('providers.authHeader')}</SelectItem>
            </SelectContent>
          </Select>
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

          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="bg-muted/20 space-y-2 rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
            {t('providers.modelsLabel')}
          </div>
          <span className="text-muted-foreground text-[10px]">
            {t('providers.protocolPriority')}
          </span>
        </div>
        <ModelTable
          models={models}
          onChange={(next) => {
            setDirty(true);
            setModels(next);
          }}
        />
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      {probeText && <p className="text-muted-foreground text-xs">{probeText}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void testRoute()}
          disabled={probing || provider.models.length === 0}
          className="flex-1"
        >
          {probing ? t('providers.testingRoute') : t('providers.testRoute')}
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving}
          className="flex-1"
        >
          {saving ? t('providers.saving') : t('providers.save')}
        </Button>
      </div>
    </ProviderShell>
  );
}
