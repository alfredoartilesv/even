import { SocialLogin } from "@capgo/capacitor-social-login";
import { isNative } from "./device";

/**
 * Sign in with Google through Android's Credential Manager (@capgo/capacitor-social-login).
 * Returns only the ID token: the account logic (features/account) reads and checks it.
 *
 * Setup (once, in Google Cloud Console, see docs/architecture.md section 5b):
 * - OAuth consent screen (Testing is fine; add your account as a test user), scopes email + profile.
 * - A "Web application" OAuth client: its id goes in VITE_GOOGLE_WEB_CLIENT_ID (.env). It is not a secret.
 * - An "Android" OAuth client for package app.health.personal with the SHA-1 of the signing key.
 */

/** The Web OAuth client id from the build environment, or null when Google sign-in is not set up. */
export const googleWebClientId: string | null = (import.meta.env?.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined)?.trim() || null;

let ready: Promise<void> | null = null;

function init(webClientId: string): Promise<void> {
  ready ??= SocialLogin.initialize({ google: { webClientId, mode: "online" } }).catch((err) => {
    ready = null; // allow a retry
    throw err;
  });
  return ready;
}

/** True when the button can be shown: native app and a client id in the build. */
export const googleSignInAvailable = isNative && googleWebClientId !== null;

/** Open the Google account picker. Resolves with the ID token, or null if the owner cancels. */
export async function googleSignIn(): Promise<string | null> {
  if (!googleWebClientId) throw new Error("Google sign-in is not set up in this build (VITE_GOOGLE_WEB_CLIENT_ID)");
  await init(googleWebClientId);
  try {
    const { result } = await SocialLogin.login({ provider: "google", options: { scopes: ["email", "profile"] } });
    if (result.responseType !== "online" || !result.idToken) throw new Error("Google did not return an ID token");
    return result.idToken;
  } catch (err) {
    if ((err as { code?: string }).code === "USER_CANCELLED") return null;
    throw err;
  }
}

/** Clear Google's sign-in state on the device (Credential Manager), so the picker shows next time. */
export async function googleSignOut(): Promise<void> {
  if (!googleWebClientId) return;
  await init(googleWebClientId);
  await SocialLogin.logout({ provider: "google" });
}
