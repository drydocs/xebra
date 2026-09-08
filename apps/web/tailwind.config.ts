import type { Config } from "tailwindcss";

/**
 * Xebra's design tokens.
 *
 * # Why colours are HSL triplets in CSS variables
 *
 * Every colour is declared in `globals.css` as bare `H S% L%` and consumed here through
 * `hsl(var(--x) / <alpha-value>)`. That indirection is what makes `text-bone/60` and
 * `border-bone/10` work: the whole interface is built from *one* neutral at varying alpha
 * rather than a ladder of hand-picked greys, which is the fastest way to keep a dark UI from
 * looking assembled out of parts. Two functional hues sit on top of it (`signal` for
 * confirmed, `alarm` for failed) and nothing else is coloured.
 *
 * # The theme
 *
 * Xebra is a zebra: the palette is monochrome on purpose — obsidian hide, bone stripe — and
 * the stripe shows up as texture and rhythm (see `.hide-stripes`, `<StripeRule/>`,
 * `<XebraMark/>`), never as decoration for its own sake.
 */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: {
          DEFAULT: "hsl(var(--obsidian) / <alpha-value>)",
          raised: "hsl(var(--obsidian-raised) / <alpha-value>)",
          sunken: "hsl(var(--obsidian-sunken) / <alpha-value>)",
        },
        bone: "hsl(var(--bone) / <alpha-value>)",
        signal: "hsl(var(--signal) / <alpha-value>)",
        alarm: "hsl(var(--alarm) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-geist)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        // Display sizes carry their own tracking and leading; a headline set at 56px with
        // default tracking reads as a paragraph that happens to be large.
        display: ["clamp(2.5rem, 7vw, 3.75rem)", { lineHeight: "0.95", letterSpacing: "-0.035em" }],
        title: ["clamp(1.5rem, 3.4vw, 1.875rem)", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        eyebrow: ["0.6875rem", { lineHeight: "1", letterSpacing: "0.18em" }],
      },
      borderRadius: {
        // Concentric radii for the double-bezel shell: outer 2rem, inner 2rem - shell padding.
        shell: "2rem",
        core: "1.625rem",
        tray: "1.125rem",
      },
      transitionTimingFunction: {
        // Apple's own sheet/scrub curve. Heavy start, long glide out — reads as mass.
        haptic: "cubic-bezier(0.32, 0.72, 0, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
      },
      transitionDuration: {
        400: "400ms",
        600: "600ms",
        800: "800ms",
      },
      boxShadow: {
        // Tinted toward the background hue rather than pure black, and stacked so the card
        // reads as a lit object: ambient occlusion, contact shadow, then an inner top edge.
        plate:
          "0 1px 0 0 hsl(var(--bone) / 0.06) inset, 0 40px 80px -32px hsl(225 40% 2% / 0.9), 0 8px 24px -12px hsl(225 40% 2% / 0.7)",
        tray: "0 1px 0 0 hsl(var(--bone) / 0.04) inset, 0 1px 2px 0 hsl(225 40% 2% / 0.6)",
        pill: "0 1px 0 0 hsl(var(--bone) / 0.5) inset, 0 8px 24px -8px hsl(var(--bone) / 0.22)",
      },
      keyframes: {
        rise: {
          from: { opacity: "0", transform: "translate3d(0, 18px, 0)", filter: "blur(6px)" },
          to: { opacity: "1", transform: "translate3d(0, 0, 0)", filter: "blur(0)" },
        },
        drift: {
          // The stripe rail crawls. Slow enough to be felt rather than watched.
          from: { transform: "translate3d(0, 0, 0)" },
          to: { transform: "translate3d(-33.333%, 0, 0)" },
        },
        sheen: {
          from: { transform: "translate3d(-120%, 0, 0)" },
          to: { transform: "translate3d(220%, 0, 0)" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.85" },
        },
      },
      animation: {
        rise: "rise 800ms cubic-bezier(0.32, 0.72, 0, 1) both",
        drift: "drift 24s linear infinite",
        sheen: "sheen 2.4s cubic-bezier(0.32, 0.72, 0, 1) infinite",
        breathe: "breathe 3.2s cubic-bezier(0.32, 0.72, 0, 1) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
