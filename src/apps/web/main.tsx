import { startApp } from "../../shell/start";
import { connectGate } from "./connectGate";

// The web app (Vercel, `vite build --mode web`): the shared shell behind its own start, which
// connects to the account before anything else (docs/phases.md).
startApp({ gate: connectGate });
