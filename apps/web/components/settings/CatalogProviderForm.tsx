'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
        <CatalogProviderEditor
          key={provider.id}
          mode="edit"
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
        <CatalogProviderEditor
          mode="create"
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

/**
 * One editor for both modes. Add and edit differ only in how the final save is
 * dispatched and whether the card is wrapped by ProviderShell; every field,
 * default and validation path is shared so the two screens cannot drift.
 */
function CatalogProviderEditor({
  mode,
  catalog,
  provider,
  expanded = true,
  onToggle,
  onDone,
}: {
  mode: 'create' | 'edit';
  catalog: CatalogProvider[] | null;
  provider?: CatalogKindProvider;
  expanded?: boolean;
  onToggle?: () => void;
  onDone?: () => void;
}) {
  const t = useTranslations('settings');
  const addProvider = useConfigStore((s) => s.addProvider);
  const editProvider = useConfigStore((s) => s.editProvider);
  const removeProvider = useConfigStore((s) => s.removeProvider);

  const firstCatalog = catalog?.[0];
  const [piProvider, setPiProvider] = useState(
    provider?.piProvider ?? firstCatalog?.id ?? '',
  );
  const [name, setName] = useState(provider?.name ?? firstCatalog?.name ?? '');
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<'auto' | ProviderProtocol>(
    provider?.protocol ?? 'auto',
  );
  const [authKind, setAuthKind] = useState<ProviderAuth['kind'] | 'auto'>(
    provider?.auth?.kind ?? 'auto',
  );
  const [defaultsOpen, setDefaultsOpen] = useState(mode === 'create');
  const [modelsOpen, setModelsOpen] = useState(true);
  const [authHeaderName, setAuthHeaderName] = useState(
    provider?.auth?.kind === 'header' ? provider.auth.name : '',
  );
  const [models, setModels] = useState<DraftModel[]>(() =>
    provider ? toCatalogDrafts(provider.models) : [],
  );
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [syncedProvider, setSyncedProvider] = useState(provider);
  if (mode === 'edit' && provider !== undefined && provider !== syncedProvider && !dirty) {
    setSyncedProvider(provider);
    setName(provider.name);
    setBaseURL(provider.baseURL ?? '');
    setProtocol(provider.protocol ?? 'auto');
    setAuthKind(provider.auth?.kind ?? 'auto');
    setAuthHeaderName(provider.auth?.kind === 'header' ? provider.auth.name : '');
    setModels(toCatalogDrafts(provider.models));
  }

  const selected = catalog?.find((c) => c.id === piProvider);
  const editing = mode === 'edit' && provider !== undefined;

  const remove = async () => {
    if (!provider) return;
    setError(null);
    try {
      await removeProvider(provider.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.deleteFailed'));
    }
  };

  const testRoute = async () => {
    if (!provider) return;
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
      const input = {
        kind: 'catalog' as const,
        name: name.trim() || selected?.name || piProvider,
        piProvider,
        baseURL: baseURL.trim() || null,
        // On edit an empty key means "keep the stored key"; on create it
        // means "no key yet". Never send null from the edit path.
        ...(editing
          ? (apiKey.trim() ? { apiKey: apiKey.trim() } : {})
          : { apiKey: apiKey.trim() || null }),
        protocol,
        auth: authKind === 'auto'
          ? null
          : authKind === 'header'
            ? { kind: 'header' as const, name: authHeaderName.trim() }
            : { kind: authKind },
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
      };
      if (editing && provider) {
        await editProvider(provider.id, input);
        setApiKey('');
        setDirty(false);
      } else {
        await addProvider(input);
        onDone?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const protocolLabel = protocol === 'auto'
    ? t('providers.protocolAuto')
    : protocol === 'openai-completions'
      ? t('providers.protocolOpenAICompletions')
      : protocol === 'openai-responses'
        ? t('providers.protocolOpenAIResponses')
        : t('providers.protocolAnthropicMessages');
  const authLabel = authKind === 'auto'
    ? t('providers.authAuto')
    : authKind === 'bearer'
      ? t('providers.authBearer')
      : authKind === 'x-api-key'
        ? t('providers.authXApiKey')
        : t('providers.authHeader');

  const fields = (
    <>
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
            <span>
              {protocolLabel} · {authLabel}
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${defaultsOpen ? 'rotate-180' : ''}`}
            />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="border-t px-3 py-3">
          <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-muted-foreground text-[11px]">Provider</span>
              <Select
                items={(catalog ?? []).map((c) => ({ value: c.id, label: c.name }))}
                value={piProvider || null}
                disabled={editing}
                onValueChange={(next) => {
                  if (editing) return;
                  const id = String(next);
                  setPiProvider(id);
                  setModels([]);
                  const found = catalog?.find((c) => c.id === id);
                  if (found) setName(found.name);
                }}
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue placeholder={t('providers.builtinPick')} />
                </SelectTrigger>
                <SelectContent width="content">
                  {(catalog ?? []).map((c) => (
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
                onChange={(e) => {
                  setDirty(true);
                  setName(e.target.value);
                }}
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
                onChange={(e) => {
                  setDirty(true);
                  setBaseURL(e.target.value);
                }}
                placeholder={selected?.baseUrl ?? t('providers.baseUrlBuiltin')}
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
                  provider?.apiKeyMasked ? t('providers.keyKeep') : t('providers.apiKey')
                }
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-muted-foreground text-[11px]">
                {t('providers.protocolDefault')}
              </span>
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
            <label className="space-y-1">
              <span className="text-muted-foreground text-[11px]">
                {t('providers.auth')}
              </span>
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
          </div>

          <p className="text-muted-foreground text-[10px]">
            {t('providers.authHint')}
          </p>

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
        </CollapsibleContent>
      </Collapsible>

      <Collapsible
        open={modelsOpen}
        onOpenChange={setModelsOpen}
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
          <span>{t('providers.modelsLabel')}</span>
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>
              {t('providers.modelCount', { count: models.length })} ·{' '}
              {t('providers.protocolPriority')}
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${modelsOpen ? 'rotate-180' : ''}`}
            />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t p-3">
          <ModelTable
            models={models}
            onChange={(next) => {
              setDirty(true);
              setModels(next);
            }}
            codeListId={editing ? `catalog-models-${provider.id}` : 'catalog-models-new'}
            emptyHint={editing ? undefined : t('providers.modelsEmptyHint')}
            {...(selected ? { codeOptions: selected.models } : {})}
          />
        </CollapsibleContent>
      </Collapsible>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </>
  );

  const actions = editing ? (
    <>
      {probeText && <p className="text-muted-foreground text-xs">{probeText}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void testRoute()}
          disabled={probing || models.length === 0}
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
    </>
  ) : (
    <div className="flex gap-2">
      <Button
        size="sm"
        onClick={() => void save()}
        disabled={saving || !piProvider}
        className="flex-1"
      >
        {saving ? t('providers.creating') : t('providers.create')}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        {t('providers.cancel')}
      </Button>
    </div>
  );

  if (!editing) {
    return (
      <div className="bg-card/50 space-y-3 rounded-lg border p-3">
        {fields}
        {actions}
      </div>
    );
  }

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
      onToggle={onToggle ?? (() => {})}
      onRemove={() => void remove()}
    >
      {fields}
      {actions}
    </ProviderShell>
  );
}
