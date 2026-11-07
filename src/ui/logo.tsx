/**
 * The Even logo: a ring half filled around an equals sign, for balance (eaten against burned,
 * stock against the days ahead, this month against the last). Drawn from palette tokens so it
 * follows the theme; resources/logo.svg is the fixed-color source of the app icons.
 */
export function Logo({ size = 48, decorative = false }: { size?: number; /** Next to the name already: hidden from screen readers. */ decorative?: boolean }) {
  const a11y = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Even" };
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" {...a11y}>
      <rect width="64" height="64" rx="15" fill="var(--brand)" />
      <circle cx="32" cy="32" r="18" fill="none" stroke="var(--brand-ring)" strokeWidth="5" />
      <path d="M32 14a18 18 0 0 1 0 36" fill="none" stroke="var(--on-brand)" strokeWidth="5" strokeLinecap="round" />
      <path d="M25 28.5h14M25 35.5h14" stroke="var(--on-brand)" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

/** The logo inside a spinning ring, for the Loading screen (styles in screens/styles.css, still under reduced motion). */
export function LoadingMark() {
  return (
    <div className="loading-mark">
      <svg className="loading-ring" width="96" height="96" viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r="42" />
        <circle className="spin" cx="50" cy="50" r="42" />
      </svg>
      <Logo size={56} decorative />
    </div>
  );
}
