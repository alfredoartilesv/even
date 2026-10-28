/**
 * The web app's connect gate, let through for the captures: the demo database is already the
 * account's data, and no sync session (passphrase, pairing) exists here to connect with.
 */
export function connectGate() {
  return null;
}
