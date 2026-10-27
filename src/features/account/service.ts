import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { applySignIn, parseGoogleIdToken, signOut, type SignInOutcome } from "./account";

/**
 * Sign-in flow for the UI. The platform pieces come in from the caller (src/app), so this runs
 * in Node too:
 *
 *   import { googleSignIn, googleSignOut, googleWebClientId, googleSignInAvailable } from "../platform/googleSignIn";
 *   const res = await signInWithGoogle(db, { signIn: googleSignIn, webClientId: googleWebClientId! });
 *   // res.status: cancelled | bound (first time: this account now owns the data) | signed_in | other_owner | error
 */

const log = createLogger("account");

export type SignInResult = SignInOutcome | { status: "cancelled" } | { status: "error"; message: string };

export async function signInWithGoogle(
  db: SqlDriver,
  deps: { signIn: () => Promise<string | null>; webClientId: string; now?: () => number },
): Promise<SignInResult> {
  const now = deps.now ?? Date.now;
  let token: string | null;
  try {
    token = await deps.signIn();
  } catch (err) {
    log.warn("Google sign-in failed", { err });
    return { status: "error", message: "Google sign-in did not complete. Check the connection and try again." };
  }
  if (!token) return { status: "cancelled" };
  try {
    const identity = parseGoogleIdToken(token, { webClientId: deps.webClientId, now: now() });
    return await applySignIn(db, identity, await deviceId(db), now());
  } catch (err) {
    log.warn("Google sign-in rejected", { err });
    return { status: "error", message: (err as Error).message };
  }
}

/** Sign out locally and on the device's Google state. The data stays bound to the owner. */
export async function signOutOfGoogle(db: SqlDriver, deps: { signOut: () => Promise<void>; now?: () => number }): Promise<void> {
  await signOut(db, (deps.now ?? Date.now)());
  try {
    await deps.signOut();
  } catch (err) {
    log.warn("Google sign-out on the device failed", { err });
  }
}
