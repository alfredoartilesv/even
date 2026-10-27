import { setLogLevel } from "../src/core/log";

// Tests exercise failure paths on purpose; keep their logs out of the test output.
// LOG_LEVEL=debug npm test shows them.
setLogLevel((process.env.LOG_LEVEL as never) ?? "silent");
