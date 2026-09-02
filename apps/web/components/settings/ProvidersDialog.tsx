'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfigStore, type Provider } from '@/stores/config-store';

interface ProvidersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProvidersDialog({ open, onOpenChange }: ProvidersDialogProps) {
  const providers = useConfigStore((s) => s.providers);
  const addProvider = useConfigStore((s) => s.addProvider);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>模型配置</DialogTitle>
          <DialogDescription>
            供应商的 apiKey 加密保存在服务端 ~/.volto，不会存入浏览器。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {providers.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))}
          {providers.length === 0 && (
            <p className="py-6 text-center text-sm text-gray-400">还没有配置供应商</p>
          )}
        </div>

        <Button
          variant="outline"
          className="w-full gap-2"
          onClick={() =>
            void addProvider({ name: '新供应商', baseURL: null, apiKey: null, models: [] })
          }
        >
          <Plus className="h-4 w-4" />
          新增供应商
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/** One provider with an editable draft; changes are saved explicitly. */
function ProviderCard({ provider }: { provider: Provider }) {
  const editProvider = useConfigStore((s) => s.editProvider);
  const removeProvider = useConfigStore((s) => s.removeProvider);

  const [name, setName] = useState(provider.name);
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(provider.models);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        models,
      });
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="供应商名称" />
        <Button
          variant="ghost"
          size="icon"
          className="text-red-500"
          onClick={() => void removeProvider(provider.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Input
        value={baseURL}
        onChange={(e) => setBaseURL(e.target.value)}
        placeholder="baseURL，留空使用默认地址"
      />
      <Input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={provider.apiKeyMasked ? `已保存 ${provider.apiKeyMasked}，留空则不修改` : 'apiKey'}
      />

      <div className="space-y-1">
        {models.map((model, index) => (
          <div key={model.id ?? index} className="flex items-center gap-2">
            <Input
              className="flex-1"
              value={model.name}
              placeholder="展示名"
              onChange={(e) =>
                setModels(models.map((m, i) => (i === index ? { ...m, name: e.target.value } : m)))
              }
            />
            <Input
              className="flex-1"
              value={model.code}
              placeholder="模型代码"
              onChange={(e) =>
                setModels(models.map((m, i) => (i === index ? { ...m, code: e.target.value } : m)))
              }
            />
            <Button
              variant="ghost"
              size="icon"
              className="text-red-500"
              onClick={() => setModels(models.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1"
          onClick={() => setModels([...models, { id: '', name: '', code: '' }])}
        >
          <Plus className="h-3 w-3" />
          新增模型
        </Button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </div>
  );
}
