import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

import './globals.css';
import { ThemeProvider, THEME_COOKIE } from '@/components/theme-provider';
import { I18nProvider } from '@/components/i18n-provider';
import { LocalePreferenceSync } from '@/components/locale-sync';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { sidebarWidthRestoreScript } from '@/lib/sidebar-width';
import { cookies } from 'next/headers';
import { resolveInitialLocale } from '@/i18n/messages';
import { LOCALE_COOKIE, LOCALE_TAG } from '@/i18n/locale';

// Fraunces carries the display headings — a warm, characterful serif with
// optical sizing, standing in for the generic sans-only look most AI chat
// UIs default to.
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  axes: ['opsz', 'SOFT', 'WONK'],
});

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

// Static: the description is copy, not a translation. A localized one would
// make the shell depend on the request again, which the static export forbids.
export const metadata = {
  title: 'Volto',
  description: 'Volto — a console for project-level AI agents',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value;
  const initialTheme =
    cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'system';
  // Cookie only: reading `navigator.languages` here would let the server and
  // client disagree on the first frame. A first-time visitor's browser
  // language is Task 5's client bootstrap to decide; `resolveInitialLocale`
  // already takes it as `languages` so that path can reuse the same rule.
  const locale = resolveInitialLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
  });
  return (
    <html
      lang={LOCALE_TAG[locale]}
      suppressHydrationWarning
      className={cn(
        'antialiased',
        display.variable,
        sans.variable,
        mono.variable,
        'font-sans',
      )}
    >
      <head>
        {/* Runs during HTML parsing, before the first paint: restores the
            persisted sidebar width into the CSS variable the layout reads,
            so the first visible frame already carries it (no default-width
            flash, no hydration mismatch — both sides render `var(...)`). */}
        <script dangerouslySetInnerHTML={{ __html: sidebarWidthRestoreScript() }} />
      </head>
      <body>
        <I18nProvider locale={locale}>
          <LocalePreferenceSync />
          <ThemeProvider initialTheme={initialTheme}>
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
