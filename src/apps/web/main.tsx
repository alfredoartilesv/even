import { startApp } from "../../shell/start";
import { connectGate } from "./connectGate";
import { SideNavFrame } from "./SideNav";
import "./web.css";

// The web app (Vercel, `vite build --mode web`): the shared shell behind its own start, which
// connects to the account before anything else, with a side menu that docks on a wide screen
// (docs/phases.md).
startApp({ gate: connectGate, Frame: SideNavFrame });
