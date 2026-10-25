import { useEffect, useState } from "react";
import { migrations } from "./db/migrations";
import { openDatabase } from "./db/open";

type DbStatus = { state: "opening" } | { state: "ready"; applied: number[] } | { state: "error"; message: string };

export function App() {
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const [db, setDb] = useState<DbStatus>({ state: "opening" });

  useEffect(() => {
    openDatabase().then(
      ({ applied }) => setDb({ state: "ready", applied }),
      (err: Error) => setDb({ state: "error", message: err.message }),
    );
  }, []);

  return (
    <main className="shell">
      <h1>Health</h1>
      <p className="muted">Phase 1 scaffold. Local schema version {latest}.</p>
      <p>
        {db.state === "opening" && "Opening local database…"}
        {db.state === "ready" &&
          (db.applied.length ? `Database ready (applied migrations ${db.applied.join(", ")}).` : "Database ready.")}
        {db.state === "error" && `Database unavailable: ${db.message}`}
      </p>
      <ul>
        <li>Next: run a freddy sync into the local database from the app.</li>
        <li>Then: the daily screens.</li>
      </ul>
    </main>
  );
}
