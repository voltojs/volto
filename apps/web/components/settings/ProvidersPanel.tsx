'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  useConfigStore,
  type Provider,
  type Model,
} from '@/stores/config-store';

/**
 * A draft model row needs a React key that stays stable for the row's whole
 * lifetime, including while `id` is still `''` (a newly-added, unsaved row).
 * `clientKey` exists only for that purpose and is stripped before the draft
 * is sent to the server — the server-side contract (empty/omitted `id` means
 * "assign a new UUID") is unchanged.
 */
interface DraftModel extends Model {
  clientKey: string;
}

function toDraftModels(models: Model[]): DraftModel[] {
  return models.map((m) => ({ ...m, clientKey: m.id || crypto.randomUUID() }));
}

/** Reads a positive-integer field, mapping an empty box back to "unset". */
function parsePositiveInt(raw: string): number | undefined {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits === '' ? undefined : Number(digits);
}

/** 模型配置 Tab：供应商、凭据与其下的模型清单。 */
export function ProvidersPanel() {
  const providers = useConfigStore((s) => s.providers);
  const addProvider = useConfigStore((s) => s.addProvider);
  const [error, setError] = useState<string | null>(null);

  const handleAddProvider = async () => {
    setError(null);
    try {
      await addProvider({
        name: '新供应商',
        baseURL: null,
        apiKey: null,
        models: [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增供应商失败');
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        供应商的 apiKey 加密保存在服务端{' '}
        <code className="font-mono">~/.volto</code>，不会存入浏览器。
      </p>

      {providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} />
      ))}
      {providers.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
          还没有配置供应商
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Button
        variant="outline"
        className="w-full gap-2 border-dashed"
        onClick={() => void handleAddProvider()}
      >
        <Plus className="h-4 w-4" />
        新增供应商
      </Button>
    </div>
  );
}

/** One provider with an editable draft; changes are saved explicitly. */
function ProviderCard({ provider }: { provider: Provider }) {
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

  const updateModel = (index: number, patch: Partial<DraftModel>) => {
    setDirty(true);
    setModels(models.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };

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
    <div className="bg-card/50 space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => {
            setDirty(true);
            setName(e.target.value);
          }}
          placeholder="供应商名称"
          className="font-medium"
        />
        {provider.apiKeyMasked && (
          <Badge variant="outline" className="font-mono">
            {provider.apiKeyMasked}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
          onClick={() => void remove()}
          aria-label="删除供应商"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Input
          value={baseURL}
          onChange={(e) => {
            setDirty(true);
            setBaseURL(e.target.value);
          }}
          placeholder="baseURL，留空使用默认地址"
          className="font-mono text-xs"
        />
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setDirty(true);
            setApiKey(e.target.value);
          }}
          placeholder={provider.apiKeyMasked ? '留空则不修改 apiKey' : 'apiKey'}
          className="font-mono text-xs"
        />
      </div>

      <Separator />

      <div className="space-y-1.5">
        <div className="text-muted-foreground font-mono text-[10px] font-medium tracking-widest uppercase">
          模型
        </div>
        {models.map((model, index) => (
          <div
            key={model.clientKey}
            className="bg-background/60 space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <Input
                className="flex-1"
                value={model.name}
                placeholder="展示名"
                onChange={(e) => updateModel(index, { name: e.target.value })}
              />
              <Input
                className="flex-1 font-mono text-xs"
                value={model.code}
                placeholder="模型代码"
                onChange={(e) => updateModel(index, { code: e.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                onClick={() => {
                  setDirty(true);
                  setModels(models.filter((_, i) => i !== index));
                }}
                aria-label="删除模型"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            {/* Both caps are optional and share a "leave empty for the
                provider's own default" story, so they sit on their own row
                with explicit labels rather than relying on placeholders that
                the narrow inputs would truncate. */}
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-[11px]">
                  上下文窗口（tokens）
                </span>
                <Input
                  className="font-mono text-xs"
                  inputMode="numeric"
                  value={model.contextWindow ?? ''}
                  placeholder="留空则不显示占用百分比"
                  onChange={(e) =>
                    updateModel(index, {
                      contextWindow: parsePositiveInt(e.target.value),
                    })
                  }
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground text-[11px]">
                  最大输出 Token
                </span>
                <Input
                  className="font-mono text-xs"
                  inputMode="numeric"
                  value={model.maxOutputTokens ?? ''}
                  placeholder="留空则用供应商默认值"
                  onChange={(e) =>
                    updateModel(index, {
                      maxOutputTokens: parsePositiveInt(e.target.value),
                    })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground gap-1"
          onClick={() => {
            setDirty(true);
            setModels([
              ...models,
              { id: '', name: '', code: '', clientKey: crypto.randomUUID() },
            ]);
          }}
        >
          <Plus className="h-3 w-3" />
          新增模型
        </Button>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Button
        size="sm"
        onClick={() => void save()}
        disabled={saving}
        className="w-full"
      >
        {saving ? '保存中…' : '保存'}
      </Button>
    </div>
  );
}
