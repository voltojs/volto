export function App(): React.JSX.Element {
  return (
    <div className="h-screen w-screen bg-neutral-50 text-neutral-900 flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">Volto Agent</h1>
        <p className="text-neutral-500 text-lg">
          Pure agent core — zero I/O, zero env coupling
        </p>
        <div className="text-sm text-neutral-400">
          Desktop app v0.0.1 • Electron + React
        </div>
      </div>
    </div>
  );
}
