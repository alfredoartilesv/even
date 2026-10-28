import { useSyncExternalStore } from "react";

/**
 * Screen widths the web layout changes at, the same as the @media rules in web.css. Under DOCKED (a
 * phone held upright) the side menu is a drawer; from DOCKED on (a phone on its side, a tablet, a
 * computer) it stays open beside the page, as icons only until ROOMY.
 */
export const DOCKED = "(min-width: 48rem)";
export const ROOMY = "(min-width: 75rem)";

/** Whether a media query matches, following the window as it is resized or the phone turned. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
