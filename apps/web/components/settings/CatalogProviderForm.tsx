'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { fetchCatalogProviders, probeProvider, type CatalogProvider, type ProviderAuth, type ProviderProtocol } from '@/lib/config-api';
import { ProviderShell } from './ProviderShell';
import { ModelTable, toCatalogDrafts, type DraftModel } from './ModelTable';

type CatalogKindProvider = Extract<Provider, { kind: 'catalog' }>;

/**
 * 内置 Provider 区块：从 pi-ai 目录挑选 provider + 勾选模型的新增入口，加上
 * 已有内置 provider 的编辑卡片列表。模型 code 全部来自目录，用户不手填。
 */
export function CatalogProviderSection({
  providers,
}: {
  providers: Provider[];
}) {
  const t = useTranslations('settings');
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** Which existing provider's editor is unfolded; at most one at a time. */
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCatalogProviders()
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : t('providers.builtinCatalogFailed'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const catalogProviders = providers.filter(
    (p): p is CatalogKindProvider => p.kind === 'catalog',
  );

  // Each pi-ai provider can be configured once (the gateway rejects a second
  // record — see config/providers.ts's assertPiProviderFree), so the ones
  // already in the list are not offered again.
  const configured = new Set(catalogProviders.map((p) => p.piProvider));
  const available = (catalog ?? []).filter((c) => !configured.has(c.id));

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
        {t('providers.builtin')}
      </div>

      {catalogProviders.map((provider) => (
        <CatalogProviderCard
          key={provider.id}
          provider={provider}
          catalog={catalog}
          expanded={openId === provider.id}
          onToggle={() =>
            setOpenId((current) =>
              current === provider.id ? null : provider.id,
            )
          }
        />
      ))}
      {catalogProviders.length === 0 && !adding && (
        <div className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
          {t('providers.builtinEmpty')}
        </div>
      )}

      {loadError && <p className="text-destructive text-xs">{loadError}</p>}

      {adding && catalog && (
        <CatalogAddForm
          catalog={available}
          onDone={() => setAdding(false)}
        />
      )}
      {!adding && (
        <Button
          variant="outline"
          className="w-full gap-2 border-dashed"
          onClick={() => setAdding(true)}
          disabled={!catalog || available.length === 0}
        >
          <Plus className="h-4 w-4" />
          {catalog && available.length === 0
            ? t('providers.builtinAllConfigured')
            : t('providers.builtinAdd')}
        </Button>
      )}
    </div>
  );
}

/** Inline form for creating a new catalog-kind provider. */
function CatalogAddForm({
  catalog,
  onDone,
}: {
  catalog: CatalogProvider[];
  onDone: () => void;
}) {
  const t = useTranslations('settings');
  const addProvider = useConfigStore((s) => s.addProvider);
  const [piProvider, setPiProvider] = useState(catalog[0]?.id ?? '');
  const [name, setName] = useState(catalog[0]?.name ?? '');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  // Starts empty rather than seeded with the provider's whole catalog:
  // several providers list dozens of models, where deleting the unwanted
  // rows is more work than adding the wanted ones. Each row's model ID box
  // autocompletes from that provider's catalog.
  const [models, setModels] = useState<DraftModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = catalog.find((c) => c.id === piProvider);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      await addProvider({
        kind: 'catalog',
        name: name.trim() || selected?.name || piProvider,
        piProvider,
        baseURL: baseURL.trim() || null,
        apiKey: apiKey.trim() || null,
        models: models
          .filter((m) => m.code.trim())
          .map((m) => ({
            code: m.code.trim(),
            ...(m.protocol === undefined ? {} : { protocol: m.protocol }),
            ...(m.name.trim() ? { name: m.name.trim() } : {}),
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
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card/50 space-y-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">Provider</span>
          <Select
            items={catalog.map((c) => ({ value: c.id, label: c.name }))}
            value={piProvider || null}
            onValueChange={(next) => {
              const id = String(next);
              setPiProvider(id);
              // Rows belong to the previous provider's catalog; switching
              // provider invalidates them.
              setModels([]);
              const found = catalog.find((c) => c.id === id);
              if (found) setName(found.name);
            }}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue placeholder={t('providers.builtinPick')} />
            </SelectTrigger>
            <SelectContent width="content">
              {catalog.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">{t('providers.displayName')}</span>
          <Input
            className="h-8"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('providers.displayName')}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">baseURL</span>
          <Input
            className="h-8 font-mono text-xs"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder={selected?.baseUrl ?? t('providers.baseUrlBuiltin')}
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">apiKey</span>
          <Input
            className="h-8 font-mono text-xs"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="apiKey"
          />
        </label>
      </div>

      <div className="space-y-1.5">
        <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
          {t('providers.modelsLabel')}
        </div>
        <ModelTable
          models={models}
          onChange={setModels}
          codeListId="catalog-models-new"
          emptyHint={t('providers.modelsEmptyHint')}
          {...(selected ? { codeOptions: selected.models } : {})}
        />
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void create()}
          disabled={saving || !piProvider}
          className="flex-1"
        >
          {saving ? t('providers.creating') : t('providers.create')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('providers.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** One existing catalog provider: apiKey + model-selection can still change; `piProvider`/`kind` cannot. */
function CatalogProviderCard({
  provider,
  catalog,
  expanded,
  onToggle,
}: {
  provider: CatalogKindProvider;
  catalog: CatalogProvider[] | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('settings');
  const editProvider = useConfigStore((s) => s.editProvider);
  const removeProvider = useConfigStore((s) => s.removeProvider);

  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '');
  const [protocol, setProtocol] = useState<'auto' | ProviderProtocol>(
    provider.protocol ?? 'auto',
  );
  const [authKind, setAuthKind] = useState<ProviderAuth['kind']>(
    provider.auth?.kind
      ?? (provider.protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
  );
  const [authHeaderName, setAuthHeaderName] = useState(
    provider.auth?.kind === 'header' ? provider.auth.name : '',
  );
  const [models, setModels] = useState<DraftModel[]>(() =>
    toCatalogDrafts(provider.models),
  );
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same untouched-only re-seed as the custom card: an external refresh must
  // reach a draft nobody is editing, and must not touch one that is.
  const [dirty, setDirty] = useState(false);
  const [syncedProvider, setSyncedProvider] = useState(provider);
  if (provider !== syncedProvider && !dirty) {
    setSyncedProvider(provider);
    setBaseURL(provider.baseURL ?? '');
    setProtocol(provider.protocol ?? 'auto');
    setAuthKind(
      provider.auth?.kind
        ?? (provider.protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
    );
    setAuthHeaderName(provider.auth?.kind === 'header' ? provider.auth.name : '');
    setModels(toCatalogDrafts(provider.models));
  }

  const catalogEntry = catalog?.find((c) => c.id === provider.piProvider);

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
      const result = await probeProvider(provider.id, { modelId: first.code });
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
        kind: 'catalog',
        // `piProvider` never changes from this card — the immutable-kind
        // contract extends in spirit to "which pi-ai provider": switching it
        // is a different set of models entirely, so that's a delete+recreate,
        // same as switching kind.
        // Empty clears the override (null), returning this provider to
        // pi-ai's own address — distinct from omitting the field, which the
        // gateway reads as "leave it alone".
        baseURL: baseURL.trim() || null,
        protocol,
        auth: authKind === 'header'
          ? { kind: 'header', name: authHeaderName.trim() }
          : { kind: authKind },
        models: models.map((m) => ({
          code: m.code,
          ...(m.protocol === undefined ? {} : { protocol: m.protocol }),
          // An empty box means "no override" — send nothing rather than an
          // empty string, or it would shadow pi-ai's own catalog value.
          ...(m.name.trim() ? { name: m.name.trim() } : {}),
          ...(m.contextWindow === undefined
            ? {}
            : { contextWindow: m.contextWindow }),
          ...(m.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: m.maxOutputTokens }),
          // Explicit boolean: the checkbox is the user's declared intent for
          // this model, stored as an override of pi-ai's catalog flag.
          reasoning: m.reasoning,
          ...(m.input === undefined ? {} : { input: m.input }),
        })),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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
      name={provider.name}
      badges={
        <>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            {provider.piProvider}
          </Badge>
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
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">baseURL</span>
          <Input
            className="h-8 font-mono text-xs"
            value={baseURL}
            onChange={(e) => {
              setDirty(true);
              setBaseURL(e.target.value);
            }}
            placeholder={catalogEntry?.baseUrl ?? t('providers.baseUrlBuiltin')}
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground text-[11px]">apiKey</span>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.apiKeyMasked ? t('providers.keyKeep') : t('providers.apiKey')}
            className="h-8 font-mono text-xs"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-muted-foreground text-[11px]">{t('providers.auth')}</span>
          <Select
            items={[
              { value: 'bearer', label: t('providers.authBearer') },
              { value: 'x-api-key', label: t('providers.authXApiKey') },
              { value: 'header', label: t('providers.authHeader') },
            ]}
            value={authKind}
            onValueChange={(next) => {
              setDirty(true);
              setAuthKind(String(next) as ProviderAuth['kind']);
            }}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent width="content">
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

      <div className="space-y-1.5">
        <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
          {t('providers.modelsLabel')}
        </div>
        <label className="block space-y-1">
          <span className="text-muted-foreground text-[11px]">{t('providers.protocol')}</span>
          <Select
            items={[
              { value: 'auto', label: t('providers.protocolAuto') },
              { value: 'openai-completions', label: t('providers.protocolOpenAICompletions') },
              { value: 'openai-responses', label: t('providers.protocolOpenAIResponses') },
              { value: 'anthropic-messages', label: t('providers.protocolAnthropicMessages') },
            ]}
            value={protocol}
            onValueChange={(next) => {
              setDirty(true);
              setProtocol(String(next) as 'auto' | ProviderProtocol);
            }}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent width="content">
              <SelectItem value="auto">{t('providers.protocolAuto')}</SelectItem>
              <SelectItem value="openai-completions">{t('providers.protocolOpenAICompletions')}</SelectItem>
              <SelectItem value="openai-responses">{t('providers.protocolOpenAIResponses')}</SelectItem>
              <SelectItem value="anthropic-messages">{t('providers.protocolAnthropicMessages')}</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {/* Model codes come from pi-ai's catalog, offered as autocomplete
            rather than a fixed list: a code this build's catalog doesn't know
            (a newly released model, or one the user configured before a pi-ai
            downgrade) must still be typeable, and must not vanish from a list
            it is already in. */}
        <ModelTable
          models={models}
          onChange={(next) => {
            setDirty(true);
            setModels(next);
          }}
          codeListId={`catalog-models-${provider.id}`}
          {...(catalogEntry ? { codeOptions: catalogEntry.models } : {})}
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
