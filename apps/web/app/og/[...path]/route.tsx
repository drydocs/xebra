import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { OG_PAGES, ogImageParams } from "../../../lib/seo/og";
import { ENDPOINT_NAMES, parseSlug } from "../../../lib/seo/routes";

/**
 * Each page's link preview, 1200×630, drawn at build time in the site's own type and colours.
 *
 * Built for every page and for every route that could ever be offered, so a Stellar chain that goes
 * live after a deploy already has its image. Static: nothing is drawn at request time.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return ogImageParams();
}

const BONE = "#f6f3ee";
const OBSIDIAN = "#0a0b0e";

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const root = process.cwd();
  const [regular, semibold, mark] = await Promise.all([
    readFile(join(root, "assets/og/Geist-Regular.ttf")),
    readFile(join(root, "assets/og/Geist-SemiBold.ttf")),
    readFile(join(root, "public/icon.svg"), "utf8"),
  ]);
  const markUri = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

  let eyebrow: string;
  let title: string;
  let sub: string;
  let logos: [string, string] | null = null;

  const route = path[0] === "bridge" && path[1] ? parseSlug(path[1]) : null;
  if (route) {
    const from = ENDPOINT_NAMES[route.from];
    const to = ENDPOINT_NAMES[route.to];
    eyebrow = "Native USDC · Circle CCTP";
    title = `${from} to ${to}`;
    sub = `Bridge USDC from ${from} to ${to}. No wrapped tokens, no custody.`;
    const [a, b] = await Promise.all(
      [route.from, route.to].map(
        async (id) =>
          `data:image/png;base64,${(await readFile(join(root, `public/chains/${id}.png`))).toString("base64")}`,
      ),
    );
    logos = [a as string, b as string];
  } else {
    const page = OG_PAGES[path.join("/")] ?? OG_PAGES.home;
    ({ eyebrow, title, sub } = page);
  }

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: `radial-gradient(circle at 85% 0%, #1a1c22 0%, ${OBSIDIAN} 55%)`,
        color: BONE,
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {/* biome-ignore lint/a11y/useAltText: rendered to an image, never to the page. */}
        <img src={markUri} width={48} height={48} />
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>Xebra</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {logos && (
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 36 }}>
            {/* biome-ignore lint/a11y/useAltText: rendered to an image, never to the page. */}
            <img src={logos[0]} width={72} height={72} style={{ borderRadius: 36 }} />
            <svg width="44" height="24" viewBox="0 0 44 24" fill="none" aria-hidden="true">
              <path
                d="M2 12h38M31 4l9 8-9 8"
                stroke="rgba(246,243,238,0.45)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {/* biome-ignore lint/a11y/useAltText: rendered to an image, never to the page. */}
            <img src={logos[1]} width={72} height={72} style={{ borderRadius: 36 }} />
          </div>
        )}
        <span
          style={{
            fontSize: 18,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(246,243,238,0.5)",
          }}
        >
          {eyebrow}
        </span>
        <span
          style={{
            marginTop: 20,
            fontSize: 72,
            fontWeight: 600,
            letterSpacing: "-0.035em",
            lineHeight: 1.02,
            maxWidth: 1000,
          }}
        >
          {title}
        </span>
        <span
          style={{ marginTop: 24, fontSize: 28, color: "rgba(246,243,238,0.55)", maxWidth: 940 }}
        >
          {sub}
        </span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 22, color: "rgba(246,243,238,0.6)" }}>xebra.exchange</span>
        <div style={{ display: "flex", gap: 6 }}>
          {[3, 6, 2, 4].map((w, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decoration.
              key={i}
              style={{
                width: w * 4,
                height: 28,
                borderRadius: 14,
                background: "rgba(246,243,238,0.18)",
              }}
            />
          ))}
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}
