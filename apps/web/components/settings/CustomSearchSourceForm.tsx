'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CustomSearchSourceInput } from '@/lib/config-api';

const POST = 'POST';
const GET = 'GET';

export interface CustomSearchSourceDraft {
  name: string;
  apiKey?: string;
  endpoint: CustomSearchSourceInput['endpoint'];
}

interface CustomSearchSourceFormProps {
  /** Existing values when editing; absent means "new source". */
  value?: { name: string; endpoint: CustomSearchSourceInput['endpoint'] } | undefined;
  onSubmit: (draft: CustomSearchSourceDraft) => Promise<void> | void;
  onCancel: () => void;
}

/** The form behind "add custom search service" and its edit action. */
export function CustomSearchSourceForm({ value, onSubmit, onCancel }: CustomSearchSourceFormProps) {
  const t = useTranslations('settings');
  const [name, setName] = useState(value?.name ?? '');
  const [method, setMethod] = useState<string>(value?.endpoint.method ?? POST);
  const [url, setUrl] = useState(value?.endpoint.url ?? '');
  const [authHeader, setAuthHeader] = useState(value?.endpoint.auth?.header ?? 'Authorization');
  const [authPrefix, setAuthPrefix] = useState(value?.endpoint.auth?.prefix ?? 'Bearer ');
  const [headersText, setHeadersText] = useState(
    value?.endpoint.headers === undefined ? '' : JSON.stringify(value.endpoint.headers),
  );
  const [bodyTemplate, setBodyTemplate] = useState(value?.endpoint.bodyTemplate ?? '');
  const [list, setList] = useState(value?.endpoint.paths.list ?? '');
  const [titlePath, setTitlePath] = useState(value?.endpoint.paths.title ?? '');
  const [urlPath, setUrlPath] = useState(value?.endpoint.paths.url ?? '');
  const [snippetPath, setSnippetPath] = useState(value?.endpoint.paths.snippet ?? '');
  const [siteNamePath, setSiteNamePath] = useState(value?.endpoint.paths.siteName ?? '');
  const [datePath, setDatePath] = useState(value?.endpoint.paths.date ?? '');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    let headers: Record<string, string> | undefined;
    if (headersText.trim() !== '') {
      try {
        headers = JSON.parse(headersText) as Record<string, string>;
      } catch {
        setError(t('tools.webSearchCustomHeadersInvalid'));
        return;
      }
    }
    const endpoint: CustomSearchSourceInput['endpoint'] = {
      method: method === GET ? GET : POST,
      url: url.trim(),
      ...(authHeader.trim() !== ''
        ? { auth: { header: authHeader.trim(), prefix: authPrefix } }
        : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(method === POST ? { bodyTemplate } : {}),
      paths: {
        list: list.trim(),
        title: titlePath.trim(),
        url: urlPath.trim(),
        ...(snippetPath.trim() !== '' ? { snippet: snippetPath.trim() } : {}),
        ...(siteNamePath.trim() !== '' ? { siteName: siteNamePath.trim() } : {}),
        ...(datePath.trim() !== '' ? { date: datePath.trim() } : {}),
      },
    };
    await onSubmit({
      name: name.trim(),
      ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
      endpoint,
    });
  };

  return (
    <div className="border-border mt-2 space-y-2 rounded border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="custom-search-name" className="text-xs">
            {t('tools.webSearchCustomName')}
          </label>
          <Input id="custom-search-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-method" className="text-xs">
            {t('tools.webSearchCustomMethod')}
          </label>
          <Select
            items={[
              { value: POST, label: POST },
              { value: GET, label: GET },
            ]}
            value={method}
            onValueChange={(next) => setMethod(String(next))}
          >
            <SelectTrigger id="custom-search-method" size="sm" aria-label={t('tools.webSearchCustomMethod')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} width="content">
              <SelectGroup>
                <SelectItem value={POST}>{POST}</SelectItem>
                <SelectItem value={GET}>{GET}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="custom-search-url" className="text-xs">
          {t('tools.webSearchCustomUrl')}
        </label>
        <Input id="custom-search-url" value={url} onChange={(event) => setUrl(event.target.value)} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="custom-search-auth-header" className="text-xs">
            {t('tools.webSearchCustomAuthHeader')}
          </label>
          <Input
            id="custom-search-auth-header"
            value={authHeader}
            onChange={(event) => setAuthHeader(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-auth-prefix" className="text-xs">
            {t('tools.webSearchCustomAuthPrefix')}
          </label>
          <Input
            id="custom-search-auth-prefix"
            value={authPrefix}
            onChange={(event) => setAuthPrefix(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="custom-search-headers" className="text-xs">
          {t('tools.webSearchCustomHeaders')}
        </label>
        <Textarea
          id="custom-search-headers"
          rows={2}
          value={headersText}
          onChange={(event) => setHeadersText(event.target.value)}
        />
      </div>

      {method === POST && (
        <div className="space-y-1">
          <label htmlFor="custom-search-body" className="text-xs">
            {t('tools.webSearchCustomBody')}
          </label>
          <Textarea
            id="custom-search-body"
            rows={3}
            value={bodyTemplate}
            onChange={(event) => setBodyTemplate(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">{t('tools.webSearchCustomBodyHint')}</p>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="custom-search-list" className="text-xs">
            {t('tools.webSearchCustomList')}
          </label>
          <Input id="custom-search-list" value={list} onChange={(event) => setList(event.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-title" className="text-xs">
            {t('tools.webSearchCustomPathTitle')}
          </label>
          <Input
            id="custom-search-title"
            value={titlePath}
            onChange={(event) => setTitlePath(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-link" className="text-xs">
            {t('tools.webSearchCustomPathUrl')}
          </label>
          <Input
            id="custom-search-link"
            value={urlPath}
            onChange={(event) => setUrlPath(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-snippet" className="text-xs">
            {t('tools.webSearchCustomPathSnippet')}
          </label>
          <Input
            id="custom-search-snippet"
            value={snippetPath}
            onChange={(event) => setSnippetPath(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-site" className="text-xs">
            {t('tools.webSearchCustomPathSiteName')}
          </label>
          <Input
            id="custom-search-site"
            value={siteNamePath}
            onChange={(event) => setSiteNamePath(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="custom-search-date" className="text-xs">
            {t('tools.webSearchCustomPathDate')}
          </label>
          <Input
            id="custom-search-date"
            value={datePath}
            onChange={(event) => setDatePath(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="custom-search-key" className="text-xs">
          {t('tools.webSearchApiKey')}
        </label>
        <Input
          id="custom-search-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">{t('tools.webSearchApiKeyHint')}</p>
      </div>

      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void submit()}>
          {t('tools.webSearchCustomSave')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          {t('tools.webSearchCustomCancel')}
        </Button>
      </div>
    </div>
  );
}
