import { migrations } from "./db/migrations";

export function App() {
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  return (
    <main className="shell">
      <h1>Health</h1>
      <p className="muted">Phase 1 scaffold. Local schema version {latest}.</p>
      <ul>
        <li>Next: wire the Capacitor SQLite driver and run migrations at startup.</li>
        <li>Then: freddy spike, then the daily screens.</li>
      </ul>
    </main>
  );
}
