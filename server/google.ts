import { createRemoteJWKSet, jwtVerify } from "jose";
import { AuthError } from "./accounts";

/**
 * Checks a Google ID token the way Google documents it: signed by Google's current keys, issued by
 * accounts.google.com for our Web OAuth client id (the phone's token is minted for that id too),
 * not expired, with a verified email. Only used to link a Google account to an Even account.
 */
const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export type GoogleVerifier = (idToken: string) => Promise<{ subject: string; email: string }>;

export function googleVerifier(clientId: string | undefined): GoogleVerifier {
  return async (idToken) => {
    if (!clientId) throw new AuthError(400, "Google sign-in is not set up on this server (GOOGLE_CLIENT_ID)");
    try {
      const { payload } = await jwtVerify(idToken, GOOGLE_KEYS, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId });
      if (typeof payload.sub !== "string" || typeof payload.email !== "string" || payload.email_verified !== true) throw new Error("incomplete token");
      return { subject: payload.sub, email: payload.email.toLowerCase() };
    } catch {
      throw new AuthError(401, "Google did not confirm this account. Try signing in with Google again.");
    }
  };
}
