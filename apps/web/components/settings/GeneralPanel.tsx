'use client';

import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
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

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

/** 通用设置 Tab：目前只有主题。 */
export function GeneralPanel() {
  // `theme` (the stored preference) rather than `resolvedTheme`, so "跟随
  // 系统" stays selectable instead of snapping to whatever the OS resolves to.
  const { theme, setTheme } = useTheme();

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
    </ItemGroup>
  );
}
