'use client';

import { useTheme } from 'next-themes';
import { AlignLeft, List, Monitor, Moon, ShieldCheck, Sparkles, Sun } from 'lucide-react';
import {
  Item,
  ItemActions,
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
import { PermissionPicker } from '@/components/chat/PermissionPicker';
import type { PermissionMode } from '@/stores/session-store';
import { useStreamDensity, type StreamDensity } from '@/lib/stream-density';
import { usePreferencesStore } from '@/stores/preferences-store';
import { providerModels, useConfigStore } from '@/stores/config-store';
import { isPermissionMode } from '@/lib/permission-mode';

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

const DENSITY_OPTIONS: Array<{ value: StreamDensity; label: string }> = [
  { value: 'detailed', label: '详细' },
  { value: 'concise', label: '简约' },
];



/**
 * Option value for one model. Providers mint their own model ids, so the same
 * id can appear under two providers — the pair is the identity, joined by a
 * character no provider or model id can contain.
 */
const TITLE_MODEL_SEPARATOR = '\u0000';

/** The value stored for "no title model": the gateway truncates instead. */
const NO_TITLE_MODEL = '';

interface TitleModelOption {
  value: string;
  label: string;
}

/**
 * Every configured model as a select option, grouped by provider name so two
 * "MiMo" entries under different providers stay distinguishable.
 */
function titleModelOptions(
  providers: ReturnType<typeof useConfigStore.getState>['providers'],
  catalogProviders: ReturnType<typeof useConfigStore.getState>['catalogProviders'],
): TitleModelOption[] {
  return providers.flatMap((provider) =>
    providerModels(provider, catalogProviders).map((model) => ({
      value: `${provider.id}${TITLE_MODEL_SEPARATOR}${model.id}`,
      label: `${provider.name} / ${model.name}`,
    })),
  );
}

/** 通用设置 Tab：主题与信息流密度。 */
export function GeneralPanel() {
  // `theme` (the stored preference) rather than `resolvedTheme`, so "跟随
  // 系统" stays selectable instead of snapping to whatever the OS resolves to.
  const { theme, setTheme } = useTheme();
  const [density, setDensity] = useStreamDensity();
  const defaultPermission = usePreferencesStore((s) => s.preferences.defaultPermissionMode);
  // 'plan' is not a choosable preset (it is entered via /plan), so a stored
  // value of 'plan' falls back to the picker's default rather than rendering
  // the read-only badge in a settings row.
  const permissionValue: PermissionMode =
    isPermissionMode(defaultPermission) && defaultPermission !== 'plan'
      ? defaultPermission
      : 'ask';
  const titleProviderId = usePreferencesStore((s) => s.preferences.titleProviderId);
  const titleModelId = usePreferencesStore((s) => s.preferences.titleModelId);
  const providers = useConfigStore((s) => s.providers);
  const catalogProviders = useConfigStore((s) => s.catalogProviders);

  const storedTitleModel =
    titleProviderId && titleModelId
      ? `${titleProviderId}${TITLE_MODEL_SEPARATOR}${titleModelId}`
      : NO_TITLE_MODEL;
  const modelOptions = titleModelOptions(providers, catalogProviders);
  // A stored model the user has since deleted has no option to select, and a
  // Select would render the raw joined id. Say what actually happened instead.
  const titleModelItems: TitleModelOption[] = [
    { value: NO_TITLE_MODEL, label: '不使用' },
    ...modelOptions,
    ...(storedTitleModel !== NO_TITLE_MODEL &&
    !modelOptions.some((option) => option.value === storedTitleModel)
      ? [{ value: storedTitleModel, label: '已失效，请重选' }]
      : []),
  ];

  const handleTitleModelChange = (next: string): void => {
    if (next === NO_TITLE_MODEL) {
      usePreferencesStore.getState().save({ titleProviderId: '', titleModelId: '' });
      return;
    }
    const [providerId, modelId] = next.split(TITLE_MODEL_SEPARATOR);
    if (!providerId || !modelId) return;
    usePreferencesStore.getState().save({ titleProviderId: providerId, titleModelId: modelId });
  };

  return (
    <ItemGroup>
      <Item variant="outline">
        <ItemMedia variant="icon">
          {/* Driven by the `.dark` class rather than a JS check: next-themes
              only knows the real theme after its blocking init script runs,
              so branching in JS here would flash the wrong icon. */}
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>主题</ItemTitle>
          <ItemDescription>
            浅色、深色，或跟随系统外观自动切换。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            items={THEME_OPTIONS}
            value={theme ?? 'system'}
            onValueChange={(next) => setTheme(String(next))}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.value === 'light' && <Sun />}
                    {option.value === 'dark' && <Moon />}
                    {option.value === 'system' && <Monitor />}
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>

      <Item variant="outline">
        <ItemMedia variant="icon">
          <AlignLeft className="hidden opacity-60 dark:block" />
          <List className="opacity-60 dark:hidden" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>显示模式</ItemTitle>
          <ItemDescription>
            详细：工具调用逐个成卡，推理可见；简约：每个工具一行，点击看详情。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            items={DENSITY_OPTIONS}
            value={density}
            onValueChange={(next) => setDensity(next as StreamDensity)}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {DENSITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>

      <Item variant="outline">
        <ItemMedia variant="icon">
          <ShieldCheck className="opacity-60" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>新会话默认权限</ItemTitle>
          <ItemDescription>
            每开一个新对话，都从这个权限档位开始。已在进行的会话不受影响。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <PermissionPicker
            value={permissionValue}
            onChange={(mode) =>
              usePreferencesStore.getState().save({ defaultPermissionMode: mode })
            }
            variant="default"
            triggerClassName="w-32"
          />
        </ItemActions>
      </Item>

      <Item variant="outline">
        <ItemMedia variant="icon">
          <Sparkles className="opacity-60" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>标题模型</ItemTitle>
          <ItemDescription>
            用一个模型给新会话起名；不选则直接截取首条消息作为标题。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            items={titleModelItems}
            value={storedTitleModel}
            onValueChange={(next) => handleTitleModelChange(String(next))}
          >
            <SelectTrigger size="sm" className="w-56">
              <SelectValue />
            </SelectTrigger>
            {/* `width="content"` lets the popup grow to its longest
                "provider / model" row instead of clipping every one of them
                to the trigger's width; `align="end"` keeps that wider popup
                inside the dialog instead of running off its right edge. */}
            <SelectContent width="content" align="end" alignItemWithTrigger={false}>
              <SelectGroup>
                {titleModelItems.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
    </ItemGroup>
  );
}
