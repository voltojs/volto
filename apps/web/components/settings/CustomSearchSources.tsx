'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  createCustomSearchSource,
  deleteCustomSearchSource,
  updateCustomSearchSource,
  type WebSearchSettingsView,
} from '@/lib/config-api';
import { CustomSearchSourceForm, type CustomSearchSourceDraft } from './CustomSearchSourceForm';

type CustomSource = WebSearchSettingsView['custom'][number];

interface CustomSearchSourcesProps {
  sources: CustomSource[];
  onChange: (view: WebSearchSettingsView) => void;
  onError: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The custom REST search sources under the web search card. */
export function CustomSearchSources({ sources, onChange, onError }: CustomSearchSourcesProps) {
  const t = useTranslations('settings');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const editing = editingId === null ? undefined : sources.find((entry) => entry.id === editingId);

  const submit = async (draft: CustomSearchSourceDraft): Promise<void> => {
    try {
      const view =
        editingId === null
          ? await createCustomSearchSource(draft)
          : await updateCustomSearchSource(editingId, draft);
      onChange(view);
      setFormOpen(false);
      setEditingId(null);
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      onChange(await deleteCustomSearchSource(id));
      setConfirmingId(null);
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <ItemGroup>
      <Item variant="outline" className="items-start">
        <ItemMedia variant="icon">
          <Plus className="opacity-60" />
        </ItemMedia>
        <ItemContent className="min-w-0 flex-1">
          <ItemTitle>{t('tools.webSearchCustomTitle')}</ItemTitle>

          {sources.length === 0 ? (
            <ItemDescription>{t('tools.webSearchCustomEmpty')}</ItemDescription>
          ) : (
            <ul className="mt-2 space-y-1">
              {sources.map((source) => (
                <li key={source.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{source.name}</span>
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    {source.method} {source.url}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('tools.webSearchCustomEdit', { name: source.name })}
                    onClick={() => {
                      setEditingId(source.id);
                      setFormOpen(true);
                      setConfirmingId(null);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('tools.webSearchCustomDelete', { name: source.name })}
                    onClick={() => setConfirmingId(source.id)}
                  >
                    <Trash2 />
                  </Button>
                  {confirmingId === source.id && (
                    <span className="flex items-center gap-1">
                      <span className="text-xs">{t('tools.webSearchCustomDeleteTitle', { name: source.name })}</span>
                      <Button size="sm" variant="destructive" onClick={() => void remove(source.id)}>
                        {t('tools.webSearchCustomDeleteConfirm')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmingId(null)}>
                        {t('tools.webSearchCustomCancel')}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {formOpen ? (
            <CustomSearchSourceForm
              value={
                editing === undefined
                  ? undefined
                  : {
                      name: editing.name,
                      endpoint:
                        editing.endpoint ?? {
                          method: editing.method === 'GET' ? 'GET' : 'POST',
                          url: editing.url,
                          paths: { list: '', title: '', url: '' },
                        },
                    }
              }
              onSubmit={submit}
              onCancel={() => {
                setFormOpen(false);
                setEditingId(null);
              }}
            />
          ) : (
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingId(null);
                setFormOpen(true);
              }}
            >
              <Plus />
              {t('tools.webSearchCustomAdd')}
            </Button>
          )}
        </ItemContent>
      </Item>
    </ItemGroup>
  );
}
