// apps/desktop-app/src/renderer/src/components/settings/ProvidersPanel.tsx
/**
 * ProvidersPanel
 * 设置面板"模型"Tab：供应商 → 模型列表的增删改查。
 *
 * 数据整体读写 `providers` 字段（走 useStoreValue）。每个供应商 / 模型的文本类
 * 输入框在 `ProviderCard` / `ModelRow` 子组件内维护本地草稿状态，输入时只更新
 * 本地 state，失焦（onBlur）才调用 `patchProvider`/`patchModel` 落盘——因为
 * electron-store 每次 `.set()` 会整体写回 StoreSchema（含全部会话消息），逐键
 * 触发会造成不必要的全量磁盘写入，参考已删除的 ApiKeyInput.tsx 的草稿模式。
 * 不做 baseURL 格式校验（沿用既有决策：完全自由输入）。
 * 手风琴式展开用本地 state（Set<providerId>），不引入新的 UI 依赖。
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Cpu, Plus, Trash2, Eye, EyeOff, Link2, KeyRound } from "lucide-react";
import { Input } from "@/renderer/src/components/ui/input";
import { Label } from "@/renderer/src/components/ui/label";
import { Button } from "@/renderer/src/components/ui/button";
import { Card } from "@/renderer/src/components/ui/card";
import { Separator } from "@/renderer/src/components/ui/separator";
import { useStoreValue } from "@/renderer/src/hooks/use-store";

/** 单个模型配置（与 main/store/schema.ts 的 ModelConfig 同构） */
export interface ModelConfig {
  id: string;
  name: string;
  code: string;
  contextLength?: number;
}

/** 单个供应商配置（与 main/store/schema.ts 的 ProviderConfig 同构） */
export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string | null;
  apiKey: string | null;
  models: ModelConfig[];
}

function newProvider(): ProviderConfig {
  return { id: crypto.randomUUID(), name: "新供应商", baseURL: null, apiKey: null, models: [] };
}

function newModel(): ModelConfig {
  return { id: crypto.randomUUID(), name: "新模型", code: "" };
}

export function ProvidersPanel() {
  const { value: providers, loading, update } = useStoreValue<ProviderConfig[]>("providers", []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleKeyVisible = (id: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const patchProvider = async (id: string, patch: Partial<ProviderConfig>) => {
    await update(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const addProvider = async () => {
    const p = newProvider();
    await update([...providers, p]);
    setExpanded((prev) => new Set(prev).add(p.id));
  };

  const deleteProvider = async (id: string) => {
    await update(providers.filter((p) => p.id !== id));
  };

  const addModel = async (providerId: string) => {
    const m = newModel();
    await update(
      providers.map((p) => (p.id === providerId ? { ...p, models: [...p.models, m] } : p)),
    );
  };

  const patchModel = async (providerId: string, modelId: string, patch: Partial<ModelConfig>) => {
    await update(
      providers.map((p) =>
        p.id === providerId
          ? { ...p, models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) }
          : p,
      ),
    );
  };

  const deleteModel = async (providerId: string, modelId: string) => {
    await update(
      providers.map((p) =>
        p.id === providerId ? { ...p, models: p.models.filter((m) => m.id !== modelId) } : p,
      ),
    );
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }

  return (
    <div className="space-y-3">
      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          还没有配置任何供应商。点击下方"新增供应商"开始配置。
        </p>
      )}

      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          isExpanded={expanded.has(provider.id)}
          keyVisible={visibleKeys.has(provider.id)}
          onToggleExpanded={() => toggleExpanded(provider.id)}
          onToggleKeyVisible={() => toggleKeyVisible(provider.id)}
          onPatch={(patch) => void patchProvider(provider.id, patch)}
          onDelete={() => void deleteProvider(provider.id)}
          onAddModel={() => void addModel(provider.id)}
          onPatchModel={(modelId, patch) => void patchModel(provider.id, modelId, patch)}
          onDeleteModel={(modelId) => void deleteModel(provider.id, modelId)}
        />
      ))}

      <Button variant="outline" size="sm" onClick={() => void addProvider()} className="w-full">
        <Plus className="h-3.5 w-3.5 mr-1" />
        新增供应商
      </Button>
    </div>
  );
}

interface ProviderCardProps {
  provider: ProviderConfig;
  isExpanded: boolean;
  keyVisible: boolean;
  onToggleExpanded: () => void;
  onToggleKeyVisible: () => void;
  onPatch: (patch: Partial<ProviderConfig>) => void;
  onDelete: () => void;
  onAddModel: () => void;
  onPatchModel: (modelId: string, patch: Partial<ModelConfig>) => void;
  onDeleteModel: (modelId: string) => void;
}

/**
 * ProviderCard
 * 单个供应商的展示 + 编辑：name / baseURL / apiKey 用本地草稿状态，
 * 失焦时若与 store 中的值不同才调用 onPatch，避免逐键触发 IPC + 全量落盘。
 */
function ProviderCard({
  provider,
  isExpanded,
  keyVisible,
  onToggleExpanded,
  onToggleKeyVisible,
  onPatch,
  onDelete,
  onAddModel,
  onPatchModel,
  onDeleteModel,
}: ProviderCardProps) {
  const [name, setName] = useState(provider.name);
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? "");
  const [apiKey, setApiKey] = useState(provider.apiKey ?? "");

  // store 侧值变化（外部更新 / 保存回填）时同步草稿
  useEffect(() => setName(provider.name), [provider.name]);
  useEffect(() => setBaseURL(provider.baseURL ?? ""), [provider.baseURL]);
  useEffect(() => setApiKey(provider.apiKey ?? ""), [provider.apiKey]);

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={isExpanded ? "收起" : "展开"}
        >
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== provider.name) onPatch({ name });
          }}
          className="font-medium flex-1"
        />
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label="删除供应商">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {isExpanded && (
        <div className="space-y-3 pl-6">
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              Base URL
            </Label>
            <Input
              placeholder="https://api.openai.com（留空使用官方地址）"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              onBlur={() => {
                const next = baseURL.trim() || null;
                if (next !== provider.baseURL) onPatch({ baseURL: next });
              }}
              className="font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1">
              <KeyRound className="h-3 w-3" />
              API Key
            </Label>
            <div className="relative">
              <Input
                type={keyVisible ? "text" : "password"}
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => {
                  const next = apiKey.trim() || null;
                  if (next !== provider.apiKey) onPatch({ apiKey: next });
                }}
                className="pr-9 font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={onToggleKeyVisible}
                aria-label={keyVisible ? "隐藏 API Key" : "显示 API Key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs flex items-center gap-1">
              <Cpu className="h-3 w-3" />
              模型列表
            </Label>
            {provider.models.length === 0 && (
              <p className="text-xs text-muted-foreground">还没有模型，点击下方新增。</p>
            )}
            {provider.models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                onPatch={(patch) => onPatchModel(model.id, patch)}
                onDelete={() => onDeleteModel(model.id)}
              />
            ))}
            <Button variant="outline" size="sm" onClick={onAddModel}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              新增模型
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

interface ModelRowProps {
  model: ModelConfig;
  onPatch: (patch: Partial<ModelConfig>) => void;
  onDelete: () => void;
}

/**
 * ModelRow
 * 单个模型的 name / code / contextLength 编辑，同样走本地草稿 + 失焦保存。
 * contextLength 输入频率低，但为保持与同一行内其它字段一致的落盘行为、
 * 避免用户连续调整数值时逐次触发全量 store 写入，这里沿用相同草稿模式。
 */
function ModelRow({ model, onPatch, onDelete }: ModelRowProps) {
  const [name, setName] = useState(model.name);
  const [code, setCode] = useState(model.code);
  const [contextLength, setContextLength] = useState(
    model.contextLength !== undefined ? String(model.contextLength) : "",
  );

  useEffect(() => setName(model.name), [model.name]);
  useEffect(() => setCode(model.code), [model.code]);
  useEffect(
    () => setContextLength(model.contextLength !== undefined ? String(model.contextLength) : ""),
    [model.contextLength],
  );

  return (
    <div className="grid grid-cols-[1fr_1fr_100px_auto] gap-2 items-center">
      <Input
        placeholder="展示名，如 GPT-4o Mini"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== model.name) onPatch({ name });
        }}
        className="text-sm"
      />
      <Input
        placeholder="模型代码，如 gpt-4o-mini"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onBlur={() => {
          if (code !== model.code) onPatch({ code });
        }}
        className="font-mono text-sm"
        autoComplete="off"
        spellCheck={false}
      />
      <Input
        placeholder="上下文长度"
        type="number"
        value={contextLength}
        onChange={(e) => setContextLength(e.target.value)}
        onBlur={() => {
          const next = contextLength ? Number(contextLength) : undefined;
          if (next !== model.contextLength) onPatch({ contextLength: next });
        }}
        className="text-sm"
      />
      <Button variant="ghost" size="sm" onClick={onDelete} aria-label="删除模型">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
