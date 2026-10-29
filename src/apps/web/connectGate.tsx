import { Suspense } from "react";
import { secretStore } from "../../platform/secureStore";
import { ConnectPanel } from "../../shell/screens";
import type { GateState } from "../../shell/target";
import { PageHeader } from "../../ui/layout";
import { forgetOnClose } from "./browserCopy";

/**
 * The web app holds a copy of the account's data, so it starts by connecting (docs/users.md
 * section 2.2): sign in with the passphrase, pair with the phone, or a new account from an invite.
 */
export function connectGate({ session, connect }: GateState, notice: string | null = null) {
  if (session === undefined) {
    return (
      <main className="shell">
        <PageHeader title="Even" />
        <p className="muted">Opening…</p>
      </main>
    );
  }
  if (session !== null) return null;
  return (
    <main className="shell">
      <PageHeader title="Even" subtitle="Your health data, on the web" />
      <section className="card">
        <h2>Connect</h2>
        {notice && <p className="warning small">{notice}</p>}
        <p className="muted small">
          The web app is a copy of what your phone holds: sign in with your recovery passphrase, pair with your phone, or start a new account with an invite.
          Everything arrives sealed and is opened here, in this browser.
        </p>
        <Suspense>
          <ConnectPanel
            secrets={secretStore}
            isNative={false}
            onConnected={(s) => {
              forgetOnClose(s);
              connect(s);
            }}
          />
        </Suspense>
      </section>
    </main>
  );
}
