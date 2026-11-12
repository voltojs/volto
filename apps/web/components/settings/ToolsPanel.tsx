'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, Save } from 'lucide-react';
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
import {
  fetchBrowserSettings,
  updateBrowserSettings,
  type BrowserSettingsView,
} from '@/lib/config-api';

const AUTO = '__auto__';
const CUSTOM = '__custom__';

function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tools tab: for now it only selects the Agent browser executable. */
export function ToolsPanel() {
  const t = useTranslations('settings');
  const [view, setView] = useState<BrowserSettingsView | null>(null);
  const [mode, setMode] = useState<string>(AUTO);
  const [customPath, setCustomPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyView = (next: BrowserSettingsView): void => {
    setView(next);
    const configured = next.configuredPath;
    const detected = configured === null
      ? undefined
      : next.browsers.find((browser) => browser.path === configured);
    if (configured === null) {
      setMode(AUTO);
      setCustomPath('');
    } else if (detected !== undefined) {
      setMode(configured);
      setCustomPath('');
    } else {
      setMode(CUSTOM);
      setCustomPath(configured);
    }
  };

  useEffect(() => {
    let active = true;
    fetchBrowserSettings()
      .then((next) => {
        if (active) applyView(next);
      })
      .catch((err: unknown) => {
        if (active) setError(t('tools.loadFailed', { error: messageOf(err) }));
      });
    return () => {
      active = false;
    };
  }, []);

  const options = view === null
    ? []
    : [
        { value: AUTO, label: t('tools.auto') },
        ...view.browsers.map((browser) => ({ value: browser.path, label: browser.label })),
        { value: CUSTOM, label: t('tools.custom') },
      ];

  const nextPath = mode === AUTO ? null : mode === CUSTOM ? customPath.trim() : mode;
  const dirty = view !== null && nextPath !== view.configuredPath;
  const canSave =
    view !== null && !saving && dirty && !(mode === CUSTOM && customPath.trim() === '');

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      applyView(await updateBrowserSettings(nextPath));
      setSaved(true);
    } catch (err: unknown) {
      setError(t('tools.saveFailed', { error: messageOf(err) }));
    } finally {
      setSaving(false);
    }
  };

  if (view === null) {
    return (
      <ItemGroup>
        <Item variant="outline">
          <ItemMedia variant="icon">
            <Monitor className="opacity-60" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t('tools.browserTitle')}</ItemTitle>
            <ItemDescription>
              {error ?? t('tools.loading')}
            </ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
    );
  }

  return (
    <ItemGroup>
      <Item variant="outline" className="items-start">
        <ItemMedia variant="icon">
          <Monitor className="opacity-60" />
        </ItemMedia>
        <ItemContent className="min-w-0 flex-1">
          <ItemTitle>{t('tools.browserTitle')}</ItemTitle>
          <ItemDescription>{t('tools.browserHint')}</ItemDescription>

          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('tools.platform', { platform: platformLabel(view.platform) })}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{t('tools.executable')}</span>
              <Select
                items={options}
                value={mode}
                onValueChange={(value) => {
                  setMode(String(value));
                  setSaved(false);
                  setError(null);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-56"
                  aria-label={t('tools.executable')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} width="content">
                  <SelectGroup>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {mode === CUSTOM && (
              <div className="space-y-1">
                <label htmlFor="browser-custom-path" className="text-sm">
                  {t('tools.customPath')}
                </label>
                <Input
                  id="browser-custom-path"
                  value={customPath}
                  placeholder={t('tools.customPlaceholder')}
                  onChange={(event) => {
                    setCustomPath(event.target.value);
                    setSaved(false);
                    setError(null);
                  }}
                />
              </div>
            )}

            {mode === AUTO && (
              <p className="text-xs text-muted-foreground">
                {view.resolvedPath === null
                  ? t('tools.notFound')
                  : t('tools.resolved', { path: view.resolvedPath })}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void save()} disabled={!canSave}>
                <Save />
                {saving ? t('tools.saving') : t('tools.save')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('tools.restartHint')}</span>
            </div>

            <p role="status" aria-live="polite" className="text-xs text-emerald-600">
              {saved ? t('tools.saved') : ''}
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </ItemContent>
      </Item>
    </ItemGroup>
  );
}
