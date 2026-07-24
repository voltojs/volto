// apps/desktop-app/src/renderer/src/components/settings/ProvidersPanel.tsx
/**
 * ProvidersPanel
 * 设置面板"模型"Tab：供应商 → 模型列表的增删改查。
 *
 * 数据整体读写 `providers` 字段（走 useStoreValue，本地维护草稿状态，
 * 失焦保存），不做 baseURL 格式校验（沿用既有决策：完全自由输入）。
 * 手风琴式展开用本地 state（Set<providerId>），不引入新的 UI 依赖。
 */

import { useState } from "react";
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

      {providers.map((provider) => {
        const isExpanded = expanded.has(provider.id);
        const keyVisible = visibleKeys.has(provider.id);
        return (
          <Card key={provider.id} className="p-3 space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleExpanded(provider.id)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={isExpanded ? "收起" : "展开"}
              >
                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              <Input
                value={provider.name}
                onChange={(e) => void patchProvider(provider.id, { name: e.target.value })}
                className="font-medium flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void deleteProvider(provider.id)}
                aria-label="删除供应商"
              >
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
                    value={provider.baseURL ?? ""}
                    onChange={(e) =>
                      void patchProvider(provider.id, { baseURL: e.target.value.trim() || null })
                    }
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
                      value={provider.apiKey ?? ""}
                      onChange={(e) =>
                        void patchProvider(provider.id, { apiKey: e.target.value.trim() || null })
                      }
                      className="pr-9 font-mono text-sm"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => toggleKeyVisible(provider.id)}
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
                    <div key={model.id} className="grid grid-cols-[1fr_1fr_100px_auto] gap-2 items-center">
                      <Input
                        placeholder="展示名，如 GPT-4o Mini"
                        value={model.name}
                        onChange={(e) => void patchModel(provider.id, model.id, { name: e.target.value })}
                        className="text-sm"
                      />
                      <Input
                        placeholder="模型代码，如 gpt-4o-mini"
                        value={model.code}
                        onChange={(e) => void patchModel(provider.id, model.id, { code: e.target.value })}
                        className="font-mono text-sm"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <Input
                        placeholder="上下文长度"
                        type="number"
                        value={model.contextLength ?? ""}
                        onChange={(e) =>
                          void patchModel(provider.id, model.id, {
                            contextLength: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                        className="text-sm"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void deleteModel(provider.id, model.id)}
                        aria-label="删除模型"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => void addModel(provider.id)}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    新增模型
                  </Button>
                </div>
              </div>
            )}
          </Card>
        );
      })}

      <Button variant="outline" size="sm" onClick={() => void addProvider()} className="w-full">
        <Plus className="h-3.5 w-3.5 mr-1" />
        新增供应商
      </Button>
    </div>
  );
}
