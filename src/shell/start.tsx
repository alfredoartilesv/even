import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLogging } from "./logging";
import { startOpeningDatabase } from "./startup";
import type { Target } from "./target";
import { applyTheme, storedTheme } from "../ui/theme";
import "../ui/palette.css";
import "../ui/areas.css";
// The design's face, bundled with the app (no font service at run time); each subset loads only for its characters.
import "@fontsource-variable/plus-jakarta-sans/index.css";
import "../screens/styles.css";

/**
 * Start the app: logging, the database open (before React renders, App picks up the same promise),
 * then the shell. Each target's main.tsx calls it; what a target does differently goes there.
 */
export function startApp(target: Target): void {
  initLogging();
  applyTheme(storedTheme());
  startOpeningDatabase();

  // The UI kit gallery (?gallery) exists in dev builds only; production never loads it.
  const Gallery = import.meta.env.DEV && new URLSearchParams(location.search).has("gallery") ? lazy(() => import("./Gallery")) : null;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {Gallery ? (
        <Suspense>
          <Gallery />
        </Suspense>
      ) : (
        <App target={target} />
      )}
    </StrictMode>,
  );
}
