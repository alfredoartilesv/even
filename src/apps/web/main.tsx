import { startApp } from "../../shell/start";

// The web app (Vercel, `vite build --mode web`). It shares the shell with Android for now; the
// web's own start (the connect gate in App) moves here when the two shells split (docs/phases.md).
startApp();
