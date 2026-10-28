import { createLogger } from "../../core/log";
import { loadSession, type SyncSession } from "../../domain/cloudsync/session";
import { idbGet, idbPut, idbReset, keepsNothing } from "../../platform/idb";
import { secretStore } from "../../platform/secureStore";

/**
 * How long the web app keeps its copy of the account's data (decided 28 Oct 2026): until it is
 * disconnected, or 30 days without being opened, or (on a shared computer) until the tab closes.
 * After that the browser has to connect again, with the passphrase or by pairing.
 */

const log = createLogger("web.copy");
export const IDLE_DAYS = 30;
const LAST_OPEN = "last-open";
const SIGNED_OUT = "even.signedOut";

export const idleExpired = (lastOpenMs: number | undefined, nowMs: number) => lastOpenMs !== undefined && nowMs - lastOpenMs > IDLE_DAYS * 86_400_000;

/** The device's token stops at the server. Best effort: the copy goes either way. */
function forgetDevice(s: SyncSession, keepalive = false): Promise<unknown> {
  return fetch(`${s.serverUrl}/v1/devices/${encodeURIComponent(s.deviceId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${s.token}` },
    keepalive,
  }).catch(() => {});
}

/**
 * Before the app starts: a copy not opened for 30 days is deleted, its device removed, and the
 * connect screen says why. Otherwise the copy is marked as opened now.
 */
export async function expireIdleCopy(nowMs = Date.now()): Promise<void> {
  try {
    if (idleExpired(await idbGet<number>(LAST_OPEN), nowMs)) {
      const session = await loadSession(secretStore).catch(() => null);
      if (session) await Promise.race([forgetDevice(session), new Promise((r) => setTimeout(r, 5_000))]);
      await idbReset();
      sessionStorage.setItem(SIGNED_OUT, "idle");
      log.info("browser copy expired", { idleDays: IDLE_DAYS });
    }
    await idbPut(LAST_OPEN, nowMs);
  } catch (err) {
    log.warn("browser copy check failed", { err });
  }
}

/** Why the connect screen is showing, once: the copy was deleted after 30 days without use. */
export function signedOutReason(): string | null {
  const why = sessionStorage.getItem(SIGNED_OUT);
  sessionStorage.removeItem(SIGNED_OUT);
  return why === "idle" ? `This browser's copy was deleted after ${IDLE_DAYS} days without use. Connect again to see your data.` : null;
}

/** On a shared computer, closing the tab also lets go of the device on the server. */
export function forgetOnClose(s: SyncSession): void {
  if (!keepsNothing()) return;
  addEventListener("pagehide", () => void forgetDevice(s, true), { once: true });
}
