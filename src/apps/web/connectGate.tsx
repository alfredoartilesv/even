import { Suspense } from "react";
import { secretStore } from "../../platform/secureStore";
import { ConnectPanel } from "../../shell/screens";
import type { GateState } from "../../shell/target";
import { PageHeader } from "../../ui/layout";
import { Logo } from "../../ui/logo";
import { forgetOnClose } from "./browserCopy";

/**
 * The web app holds a copy of the account's data, so it starts by connecting (docs/users.md
 * section 2.2): log in with the passphrase or sign up from an invite, with the
 * pairing QR beside them for a phone or browser already connected.
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
    <main className="shell connect-gate">
      <div className="connect-brand">
        <PageHeader
          title="Even"
          subtitle="Your health data, on the web. It arrives sealed and is opened only here, in this browser."
          leading={<Logo size={48} decorative />}
        />
      </div>
      {notice && <p className="warning small">{notice}</p>}
      <section className="card connect-card" aria-label="Connect">
        {/* The panel is lazy: without a fallback the card sat empty while it loaded. */}
        <Suspense fallback={<p className="muted">Loading…</p>}>
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
