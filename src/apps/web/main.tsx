import { startApp } from "../../shell/start";
import { expireIdleCopy, signedOutReason } from "./browserCopy";
import { connectGate } from "./connectGate";

// The web app (Vercel, `vite build --mode web`): the shared shell behind its own start. A copy
// unused for 30 days goes first; then the app connects to the account before anything else
// (docs/phases.md, docs/users.md section 2.2).
await expireIdleCopy();
const notice = signedOutReason();
startApp({ gate: (state) => connectGate(state, notice) });
