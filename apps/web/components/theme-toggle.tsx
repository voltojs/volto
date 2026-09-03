'use client';

import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="切换主题"
            onClick={() =>
              setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
            }
          />
        }
      >
        {/* Driven by the `.dark` class via CSS rather than a `resolvedTheme
            === 'dark'` check in JS: next-themes only knows the real theme
            after its blocking init script runs, so branching in JS here
            would flash the wrong icon (or mismatch during hydration). The
            `dark:` variant has no such gap — it reflects the class the
            instant it's set, before paint. */}
        <Sun className="h-4 w-4 dark:hidden" />
        <Moon className="hidden h-4 w-4 dark:block" />
      </TooltipTrigger>
      <TooltipContent>
        切换主题 <Kbd>D</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
