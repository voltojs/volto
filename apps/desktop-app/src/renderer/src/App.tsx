import { Bar } from "./components/Bar";
import { useShellState } from "./hooks/use-shell-state";

export default function App() {
  const state = useShellState();

  if (state === null) {
    return <div className="h-11 bg-background" />;
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Bar state={state} />
      {state.sheetOpen ? (
        <section className="flex-1 overflow-y-auto px-8 py-6">
          <h1 className="text-lg font-semibold">网关</h1>
          <p className="mt-2 text-sm text-muted-foreground">网关管理界面正在实现。</p>
        </section>
      ) : null}
    </div>
  );
}