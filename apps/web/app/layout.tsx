import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

import './globals.css';
import { ThemeProvider, THEME_COOKIE } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { NextIntlClientProvider } from 'next-intl';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';

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

export async function generateMetadata() {
  const t = await getTranslations('common');
  return { title: 'Volto', description: t('meta.description') };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const cookieStore = await cookies();
  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value;
  const initialTheme =
    cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'system';
  return (
    <html
      lang={locale === 'en' ? 'en' : 'zh-CN'}
      suppressHydrationWarning
      className={cn(
        'antialiased',
        display.variable,
        sans.variable,
        mono.variable,
        'font-sans',
      )}
    >
      <body>
        <NextIntlClientProvider>
          <ThemeProvider initialTheme={initialTheme}>
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
