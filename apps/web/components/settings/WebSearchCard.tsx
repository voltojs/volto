'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CustomSearchSources } from './CustomSearchSources';
import {
  fetchWebSearchSettings,
  testWebSearch,
  updateWebSearchSettings,
  type WebSearchSettingsView,
  type WebSearchTestResult,
} from '@/lib/config-api';

type Translate = (key: string, values?: Record<string, string | number>) => string;

const AUTO = 'auto';
const OFF = 'off';
const DEEPSEEK = 'deepseek';
const KEY_MODE = 'key';
const CHANNEL_MODE = 'channel';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line describing what a new session would actually use. */
function resolvedLine(t: Translate, resolved: WebSearchSettingsView['resolved']): string {
  switch (resolved.reason) {
    case 'auto-channel':
      return t('tools.webSearchResolvedAutoChannel');
    case 'reuse-channel':
      return t('tools.webSearchResolvedReuse', { label: resolved.label });
    case 'configured':
    case 'custom':
      return t('tools.webSearchResolvedConfigured', { label: resolved.label });
    case 'off':
      return t('tools.webSearchResolvedOff');
    default:
      return t('tools.webSearchResolvedUnconfigured');
  }
}

/** Tools tab → web search: the source, its credential and a live test. */
export function WebSearchCard() {
  const t = useTranslations('settings');
  const [view, setView] = useState<WebSearchSettingsView | null>(null);
  const [source, setSource] = useState<string>(AUTO);
  const [authMode, setAuthMode] = useState<string>(KEY_MODE);
  const [channelId, setChannelId] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null);

  const applyView = (next: WebSearchSettingsView): void => {
    setView(next);
    setSource(next.source);
    setChannelId(next.builtins.deepseek.sourceProviderId ?? '');
    setAuthMode(
      next.builtins.deepseek.sourceProviderId !== null && next.source === DEEPSEEK
        ? CHANNEL_MODE
        : KEY_MODE,
    );
    setApiKey('');
  };

  useEffect(() => {
    let active = true;
    fetchWebSearchSettings()
      .then((next) => {
        if (active) applyView(next);
      })
      .catch((err: unknown) => {
        if (active) setError(t('tools.webSearchLoadFailed', { error: messageOf(err) }));
      });
    return () => {
      active = false;
    };
  }, []);

  if (view === null) {
    return (
      <ItemGroup>
        <Item variant="outline">
          <ItemMedia variant="icon">
            <Search className="opacity-60" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('tools.webSearchTitle')}</ItemTitle>
            <ItemDescription>{error ?? t('tools.webSearchLoading')}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
    );
  }

  const isBuiltin = source === DEEPSEEK || source === 'brave' || source === 'glm';
  const isCustom = view.custom.some((entry) => entry.id === source);
  const showsKeyInput = isBuiltin && !(source === DEEPSEEK && authMode === CHANNEL_MODE);
  const masked = builtinMasked(view, source);
  const sourceOptions = [
    { value: AUTO, label: t('tools.webSearchSourceAuto') },
    { value: DEEPSEEK, label: 'DeepSeek' },
    { value: 'brave', label: 'Brave' },
    { value: 'glm', label: 'GLM' },
    ...view.custom.map((entry) => ({ value: entry.id, label: entry.name })),
    { value: OFF, label: t('tools.webSearchSourceOff') },
  ];
  const dirty =
    source !== view.source ||
    apiKey.trim() !== '' ||
    (source === DEEPSEEK && authMode === CHANNEL_MODE && channelId !== (view.builtins.deepseek.sourceProviderId ?? ''));

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { source };
      if (isBuiltin) {
        const slot: Record<string, unknown> = {};
        if (apiKey.trim() !== '') slot['apiKey'] = apiKey.trim();
        if (source === DEEPSEEK) {
          slot['sourceProviderId'] =
            authMode === CHANNEL_MODE && channelId !== '' ? channelId : null;
        }
        body[source] = slot;
      }
      applyView(await updateWebSearchSettings(body));
      setSaved(true);
    } catch (err: unknown) {
      setError(t('tools.webSearchSaveFailed', { error: messageOf(err) }));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await testWebSearch({ source }));
    } catch (err: unknown) {
      setError(t('tools.webSearchTestFailed', { error: messageOf(err) }));
    } finally {
      setTesting(false);
    }
  };

  return (
    <ItemGroup>
      <Item variant="outline" className="items-start">
        <ItemMedia variant="icon">
          <Search className="opacity-60" />
        </ItemMedia>
        <ItemContent className="min-w-0 flex-1">
          <ItemTitle>{t('tools.webSearchTitle')}</ItemTitle>
          <ItemDescription>{t('tools.webSearchHint')}</ItemDescription>

          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('tools.webSearchResolved', { line: resolvedLine(t, view.resolved) })}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{t('tools.webSearchSource')}</span>
              <Select
                items={sourceOptions}
                value={source}
                onValueChange={(value) => {
                  setSource(String(value));
                  setSaved(false);
                  setError(null);
                  setTestResult(null);
                }}
              >
                <SelectTrigger size="sm" className="w-56" aria-label={t('tools.webSearchSource')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} width="content">
                  <SelectGroup>
                    {sourceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {source === DEEPSEEK && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">{t('tools.webSearchAuth')}</span>
                <Select
                  items={[
                    { value: KEY_MODE, label: t('tools.webSearchAuthKey') },
                    { value: CHANNEL_MODE, label: t('tools.webSearchAuthChannel') },
                  ]}
                  value={authMode}
                  onValueChange={(value) => {
                    setAuthMode(String(value));
                    setSaved(false);
                    setError(null);
                  }}
                >
                  <SelectTrigger size="sm" className="w-56" aria-label={t('tools.webSearchAuth')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} width="content">
                    <SelectGroup>
                      <SelectItem value={KEY_MODE}>{t('tools.webSearchAuthKey')}</SelectItem>
                      <SelectItem value={CHANNEL_MODE}>{t('tools.webSearchAuthChannel')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}

            {source === DEEPSEEK && authMode === CHANNEL_MODE && (
              <div className="space-y-1">
                {view.candidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('tools.webSearchNoChannels')}</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{t('tools.webSearchChannel')}</span>
                    <Select
                      items={view.candidates.map((candidate) => ({
                        value: candidate.id,
                        label: candidate.name,
                      }))}
                      value={channelId}
                      onValueChange={(value) => {
                        setChannelId(String(value));
                        setSaved(false);
                        setError(null);
                      }}
                    >
                      <SelectTrigger size="sm" className="w-56" aria-label={t('tools.webSearchChannel')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false} width="content">
                        <SelectGroup>
                          {view.candidates.map((candidate) => (
                            <SelectItem key={candidate.id} value={candidate.id}>
                              {candidate.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {showsKeyInput && (
              <div className="space-y-1">
                <label htmlFor="web-search-key" className="text-sm">
                  {t('tools.webSearchApiKey')}
                </label>
                <Input
                  id="web-search-key"
                  type="password"
                  value={apiKey}
                  placeholder={
                    masked === null
                      ? t('tools.webSearchApiKey')
                      : t('tools.webSearchApiKeyPlaceholder', { masked })
                  }
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setSaved(false);
                    setError(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('tools.webSearchApiKeyHint')}</p>
              </div>
            )}

            {isCustom && masked !== null && (
              <p className="text-xs text-muted-foreground">
                {t('tools.webSearchApiKeyPlaceholder', { masked })}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                <Save />
                {saving ? t('tools.saving') : t('tools.save')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runTest()}
                disabled={testing || source === OFF}
              >
                <Search />
                {testing ? t('tools.webSearchTesting') : t('tools.webSearchTest')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('tools.webSearchNewSessionHint')}</span>
            </div>

            <p role="status" aria-live="polite" className="text-xs text-emerald-600">
              {saved ? t('tools.saved') : ''}
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            {testResult?.error !== undefined && (
              <p role="alert" className="text-xs text-destructive">
                {t('tools.webSearchTestFailed', { error: testResult.error })}
              </p>
            )}
            {testResult?.hits !== undefined && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {t('tools.webSearchResolvedConfigured', { label: testResult.resolved.label })}
                </p>
                {testResult.hits.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('tools.webSearchTestEmpty')}</p>
                ) : (
                  <ul className="space-y-1">
                    {testResult.hits.slice(0, 3).map((hit) => (
                      <li key={hit.url} className="truncate text-xs">
                        <a className="underline" href={hit.url} target="_blank" rel="noreferrer">
                          {hit.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {view.warnings.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t('tools.webSearchWarnings')}</p>
                {view.warnings.map((warning) => (
                  <p key={warning} className="text-xs text-amber-600">
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </div>
        </ItemContent>
      </Item>

      <CustomSearchSources
        sources={view.custom}
        onChange={applyView}
        onError={(message) => setError(message)}
      />
    </ItemGroup>
  );
}

function builtinMasked(view: WebSearchSettingsView, source: string): string | null {
  if (source === DEEPSEEK) return view.builtins.deepseek.apiKeyMasked;
  if (source === 'brave') return view.builtins.brave.apiKeyMasked;
  if (source === 'glm') return view.builtins.glm.apiKeyMasked;
  return view.custom.find((entry) => entry.id === source)?.apiKeyMasked ?? null;
}
