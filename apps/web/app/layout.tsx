import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

import './globals.css';
import { browserBootScript, CONFIG_SCRIPT_URL } from '@/lib/browser-boot';
import { cn } from '@/lib/utils';
import { sidebarWidthRestoreScript } from '@/lib/sidebar-width';

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

/**
 * The static shell. It reads no request state — an exported build is plain
 * files, so there is no cookie to read here — and renders the same markup for
 * every visitor. The locale and theme that the first frame shows are decided
 * by the blocking script in `<head>` (`browserBootScript`), which publishes
 * them on `<html>`: `lang` is the default language there and the script
 * corrects it during parsing, which is why the element carries
 * `suppressHydrationWarning`.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
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
        <script
          dangerouslySetInnerHTML={{ __html: sidebarWidthRestoreScript() }}
        />
        {/* Runtime configuration of the deployment, read by the client. The
            gateway serves its own content for this path; the copy shipped in
            `public/` is the same-origin default. A plain `src` (not
            `next/script`) keeps it a synchronous head load — React already
            preloads it — and the boot script below supplies the same default
            when the gateway replaces this line. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- it is read
            synchronously by `gatewayUrl()`; deferring it would race the first
            request the shell makes. */}
        <script src={CONFIG_SCRIPT_URL} />
        {/* Same trick for the locale and theme: decide them from the cookies
            and `navigator.languages` while the document is still parsing, so
            the first frame is already in the right language and theme. */}
        <script dangerouslySetInnerHTML={{ __html: browserBootScript() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
