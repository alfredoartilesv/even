import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../../core/log";
import type { FrameAccount, FrameProps } from "../../shell/target";
import { DISABLED_HINT, TABS, type Tab, type TabItem } from "../../shell/tabs";
import { Icon } from "../../ui/icons";
import { NavMenu } from "../../ui/layout";
import { Logo } from "../../ui/logo";
import { DOCKED, ROOMY, useMedia } from "./media";

const log = createLogger("nav");

/** Where the docked menu's width is kept: a layout choice of this device, not data, so not in the database. */
const RAIL_KEY = "even.nav.rail";

function storedRail(): boolean | null {
  try {
    const v = localStorage.getItem(RAIL_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

export interface SideNavState {
  /** The menu stays beside the page (a wide screen) rather than opening over it. */
  docked: boolean;
  /** The drawer is open (a narrow screen). */
  open: boolean;
  /** Docked as icons only. */
  rail: boolean;
  setOpen: (open: boolean) => void;
  toggleRail: () => void;
}

/**
 * The menu's state for the shell: a drawer on a phone held upright, docked beside the page on a
 * wider screen. Docked, it shows icons only until the screen is roomy, unless the owner chose.
 */
export function useSideNav(): SideNavState {
  const docked = useMedia(DOCKED);
  const roomy = useMedia(ROOMY);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<boolean | null>(storedRail);
  const rail = chosen ?? !roomy;
  const toggleRail = useCallback(() => {
    const next = !rail;
    setChosen(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    } catch (err) {
      log.warn("menu width not kept", { err });
    }
  }, [rail]);
  // Turned or resized to a wide screen: the menu is docked, a drawer left open would hold the page.
  useEffect(() => {
    if (docked) setOpen(false);
  }, [docked]);
  return { docked, open: open && !docked, rail: docked && rail, setOpen, toggleRail };
}

/**
 * The sections in a dark side menu, each with an icon tile in its area's colour, and You and the
 * account with Sign out at its foot. On a phone held
 * upright it slides in over the page from the menu button and closes on a choice, a tap outside or
 * Escape; on a wider screen it stays docked on the left, with a button to narrow it to icons and back.
 */
export function SideNav({
  tab,
  onTab,
  nav,
  account,
  tabs = TABS,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  nav: SideNavState;
  account: FrameAccount | null;
  tabs?: TabItem[];
}) {
  const { docked, open, rail, setOpen, toggleRail } = nav;
  const ref = useRef<HTMLElement>(null);

  // Open: focus moves into the menu, Escape closes it, and focus goes back to where it was.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button[aria-current]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("nav-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("nav-open");
      before?.focus();
    };
  }, [open, setOpen]);

  return (
    <>
      {open && <div className="nav-scrim" onClick={() => setOpen(false)} />}
      {/* Closed, the drawer is off screen and inert: out of the tab order and hidden from screen readers. */}
      <nav ref={ref} id="sidenav" className={`sidenav${open ? " open" : ""}${rail ? " rail" : ""}`} aria-label="Sections" inert={!docked && !open}>
        <div className="sidenav-head">
          <Logo size={34} decorative />
          <span className="sidenav-name">Even</span>
          <button
            type="button"
            className="sidenav-toggle"
            aria-label={docked ? (rail ? "Expand menu" : "Collapse menu") : "Close menu"}
            aria-expanded={docked ? !rail : undefined}
            onClick={docked ? toggleRail : () => setOpen(false)}
          >
            <Icon name={docked ? "panel" : "close"} />
          </button>
        </div>
        <ul>
          {tabs
            .filter((t) => t.id !== "you")
            .map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  data-area={t.id}
                  className={`sidenav-item${tab === t.id ? " active" : ""}`}
                  aria-current={tab === t.id ? "page" : undefined}
                  title={t.disabled ? DISABLED_HINT : rail ? t.label : undefined}
                  disabled={t.disabled}
                  aria-description={t.disabled ? DISABLED_HINT : undefined}
                  onClick={() => {
                    setOpen(false);
                    onTab(t.id);
                  }}
                >
                  <span className="sidenav-tile" aria-hidden>
                    <Icon name={t.icon} size={18} />
                  </span>
                  <span className="sidenav-label">{t.label}</span>
                </button>
              </li>
            ))}
        </ul>
        <button
          type="button"
          data-area="you"
          className={`sidenav-item sidenav-you${tab === "you" ? " active" : ""}`}
          aria-current={tab === "you" ? "page" : undefined}
          title={rail ? (account?.email ?? "You") : undefined}
          onClick={() => {
            setOpen(false);
            onTab("you");
          }}
        >
          {/* Signed in, You is the account: its email stands for it (the owner's ask, 9 Nov 2026). */}
          {account ? (
            <span className="sidenav-tile sidenav-avatar" aria-hidden>
              {account.email.charAt(0).toUpperCase()}
            </span>
          ) : (
            <span className="sidenav-tile" aria-hidden>
              <Icon name="user" size={18} />
            </span>
          )}
          <span className="sidenav-label sidenav-you-text">
            {account ? <span className="sidenav-you-email">{account.email}</span> : <span>You</span>}
            {!account && <span className="sidenav-sub">Targets, privacy, backup</span>}
          </span>
        </button>
        {account && <AccountFoot account={account} rail={rail} />}
      </nav>
    </>
  );
}

/** Sign out: this browser's copy of the data goes, the phone and the server keep theirs. Who is signed in shows on You above it. */
function AccountFoot({ account, rail }: { account: FrameAccount; rail: boolean }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    if (!confirm(`Sign out ${account.email}? This browser's copy of your data is removed; your phone and the server keep theirs.`)) return;
    setBusy(true);
    try {
      await account.signOut();
    } catch (err) {
      log.warn("sign out failed", { err });
      setBusy(false);
    }
  };
  return (
    <div className="sidenav-foot">
      <button type="button" className="sidenav-item sidenav-signout" title={rail ? "Sign out" : undefined} disabled={busy} onClick={() => void signOut()}>
        <Icon name="signout" />
        <span className="sidenav-label">{busy ? "Signing out…" : "Sign out"}</span>
      </button>
    </div>
  );
}

/**
 * The web app's frame: the side menu beside the page, and the menu button for PageHeader. Docked,
 * the page moves over by the menu's width (web.css).
 */
export function SideNavFrame({ tab, onTab, tabs, account, children }: FrameProps) {
  const nav = useSideNav();
  return (
    <div className={`app-frame${nav.rail ? " rail" : ""}`}>
      <SideNav nav={nav} tab={tab} onTab={onTab} tabs={tabs} account={account} />
      <NavMenu value={{ open: nav.open, onOpen: () => nav.setOpen(true) }}>{children}</NavMenu>
    </div>
  );
}
