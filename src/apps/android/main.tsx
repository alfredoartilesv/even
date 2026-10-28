import { startApp } from "../../shell/start";
import { TabBarFrame } from "./TabBar";
import "./android.css";

// The Android app (Capacitor): the shared shell with the tab bar at the bottom, in thumb reach.
// Android-only start-up and screens go in this folder (docs/phases.md).
startApp({ Frame: TabBarFrame });
