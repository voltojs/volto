'use client';

import dynamic from 'next/dynamic';

/**
 * The exported page is a shell: the real layout renders only in the browser,
 * after the boot script has decided the locale and theme. Prerendering it
 * would bake one language's copy into static HTML that every visitor shares,
 * so the page renders on the client only.
 */
const AppShell = dynamic(() => import('./app-shell'), {
  ssr: false,
  loading: () => <div className="bg-background h-screen" />,
});

export default function Home() {
  return <AppShell />;
}
