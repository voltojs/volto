'use client';

/**
 * The application layout, mounted by the client-only page shell.
 *
 * The locale and theme it renders with come from the `<html>` attributes the
 * boot script published before paint (`readBrowserBoot`), so the first client
 * render matches the frame already on screen and nothing switches afterwards.
 * The providers below only react to later changes — a locale switch, or the
 * stored preferences arriving from the gateway.
 */
import { useState } from 'react';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { I18nProvider } from '@/components/i18n-provider';
import { LocalePreferenceSync } from '@/components/locale-sync';
import { CapabilitiesBoot } from '@/components/capabilities-boot';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { readBrowserBoot } from '@/lib/browser-boot';

export default function AppShell() {
  // Read once: a remount must not adopt a theme the boot script never saw.
  const [boot] = useState(readBrowserBoot);

  return (
    <I18nProvider locale={boot.locale}>
      <LocalePreferenceSync />
      <CapabilitiesBoot />
      <ThemeProvider initialTheme={boot.theme}>
        <TooltipProvider>
          <div className="bg-background flex h-screen">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatPanel />
            </div>
          </div>
        </TooltipProvider>
        <Toaster />
      </ThemeProvider>
    </I18nProvider>
  );
}
