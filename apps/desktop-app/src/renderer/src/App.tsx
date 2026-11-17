import { Connections } from "./components/Connections";
import { useShellState } from "./hooks/use-shell-state";

export default function App() {
  const state = useShellState();

  if (state === null) {
    return <div className="h-full bg-background" />;
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Connections state={state} />
    </div>
  );
}
