import { startApp } from "../../shell/start";
import { expireIdleCopy, signedOutReason } from "./browserCopy";
import { connectGate } from "./connectGate";
import { SideNavFrame } from "./SideNav";
import "./web.css";

// The web app (Vercel, `vite build --mode web`): the shared shell behind its own start. A copy
// unused for 30 days goes first; then the app connects to the account before anything else, with
// a side menu that docks on a wide screen (docs/phases.md, docs/users.md section 2.2).
await expireIdleCopy();
const notice = signedOutReason();
startApp({ gate: (state) => connectGate(state, notice), Frame: SideNavFrame });
