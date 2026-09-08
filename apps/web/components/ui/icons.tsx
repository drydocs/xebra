import type React from "react";

/**
 * Hairline icon set.
 *
 * Every glyph is drawn on a 24-unit grid at a uniform 1.25 stroke with round joins, so they
 * sit together without one looking heavier than its neighbour. They are local rather than a
 * dependency because an icon package's default weight (Lucide's 2px in particular) reads as
 * markered-on next to Geist at these sizes, and because this is nine shapes.
 */
type IconProps = { className?: string };

function Glyph({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function ArrowUpRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 16 16 8" />
      <path d="M9.5 8H16v6.5" />
    </Glyph>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 12h16" />
      <path d="M14.5 6.5 20 12l-5.5 5.5" />
    </Glyph>
  );
}

export function Check(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Glyph>
  );
}

export function Spark(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 13.4 11l2.6 1-2.6 1-1.4 2.5L10.6 13 8 12l2.6-1z" />
    </Glyph>
  );
}

export function Vault(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 5.5v1.6M12 16.9v1.6M18.4 12h-1.6M7.2 12H5.6" />
    </Glyph>
  );
}

export function Fingerprint(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5.5 13.5a6.5 6.5 0 0 1 13 0" />
      <path d="M8.8 15.5a3.2 3.2 0 0 1 6.4 0" />
      <path d="M12 18.2v-.01" />
    </Glyph>
  );
}

export function Copy(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" />
    </Glyph>
  );
}

export function Info(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.8h.01" />
    </Glyph>
  );
}

export function Alert(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V13" />
      <path d="M12 16.4h.01" />
    </Glyph>
  );
}
