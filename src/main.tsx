import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initLogging } from "./app/logging";
import "./app/styles.css";

initLogging();

// The UI kit gallery (?gallery) exists in dev builds only; production never loads it.
const Gallery = import.meta.env.DEV && new URLSearchParams(location.search).has("gallery") ? lazy(() => import("./app/Gallery")) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {Gallery ? (
      <Suspense>
        <Gallery />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
