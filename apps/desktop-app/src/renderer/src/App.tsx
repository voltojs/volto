import { useEffect } from "react";

import { Connections } from "./components/Connections";
import { useShellState } from "./hooks/use-shell-state";
import type { ShellLocale, ShellTheme } from "@shared/gateway";

/** Follow the stored preference (and the OS, for `system`) on the settings page. */
function useAppearance(theme: ShellTheme, locale: ShellLocale): void {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      const root = document.documentElement;
      root.classList.toggle("dark", dark);
      root.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  }, [locale]);
}

export default function App() {
  const state = useShellState();

  useAppearance(state?.theme ?? "system", state?.locale ?? "zh");

  if (state === null) {
    return <div className="h-full bg-background" />;
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Connections state={state} />
    </div>
  );
}
