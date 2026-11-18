import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { serverArtwork, svgImage, type ShareSymbol } from "./og-art";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT = "OpenShip. Deploy anything. Own everything.";

export interface ShareCard {
  title: string;
  secondLine?: string;
  subtitle?: string;
  eyebrow?: string;
  symbol?: ShareSymbol;
  accent?: string;
  logos?: readonly { name: string; src: string }[];
}

const home: ShareCard = {
  title: "Deploy anything.",
  secondLine: "Own everything.",
  subtitle: "Run your apps on OpenShip Cloud\nor your own servers.",
};

const field = svgImage(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="630">
  <defs>
    <pattern id="dot" width="15" height="15" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#9b979f"/></pattern>
    <radialGradient id="fade"><stop stop-color="white"/><stop offset=".69" stop-color="#999"/><stop offset="1" stop-color="black"/></radialGradient>
    <mask id="mask"><ellipse cx="325" cy="318" rx="290" ry="294" fill="url(#fade)"/></mask>
  </defs>
  <path d="M0 0h600v630H0z" fill="url(#dot)" mask="url(#mask)" opacity=".6"/>
</svg>`);

let font: Promise<Buffer> | undefined;
export async function renderOgImage(card: ShareCard = home) {
  font ??= readFile(join(process.cwd(), "src/lib/og-fonts/Gellix-Medium.woff"));
  const { title, secondLine, subtitle, eyebrow, logos, symbol = "home", accent } = card;
  const size = secondLine ? 81 : title.length > 65 ? 52 : title.length > 36 ? 62 : 72;

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        backgroundColor: "#f8f8f5",
        color: "#161918",
        fontFamily: "Gellix",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <img
        src={field}
        width={600}
        height={630}
        style={{ position: "absolute", right: 0, top: 0 }}
      />
      <img
        src={svgImage(serverArtwork(symbol, accent))}
        width={547}
        height={527}
        style={{ position: "absolute", right: 18, top: 62 }}
      />
      <div
        style={{
          position: "absolute",
          top: 52,
          left: 65,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ width: 31, height: 31, border: "4px solid #171918", borderRadius: 32 }} />
        <div style={{ fontSize: 34, letterSpacing: -1.7, lineHeight: 1 }}>OpenShip</div>
        {eyebrow && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              borderLeft: "1px solid #c8cac4",
              marginLeft: 8,
              paddingLeft: 18,
              color: "#565b57",
              fontSize: 23,
            }}
          >
            {eyebrow}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          position: "absolute",
          top: 120,
          bottom: 86,
          left: 64,
          width: 634,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: size,
            lineHeight: 1.02,
            letterSpacing: -size * 0.055,
          }}
        >
          <span style={{ lineClamp: 3 }}>{title}</span>
          {secondLine && <span style={{ color: "#636863" }}>{secondLine}</span>}
        </div>
        {subtitle && (
          <div
            style={{
              display: "block",
              whiteSpace: "pre-wrap",
              width: 572,
              marginTop: 27,
              fontSize: 27,
              lineHeight: 1.28,
              letterSpacing: -0.6,
              color: "#555c57",
              lineClamp: 3,
            }}
          >
            {subtitle}
          </div>
        )}
        {!!logos?.length && (
          <div style={{ display: "flex", gap: 16, marginTop: 19 }}>
            {logos.map((logo) => (
              <img key={logo.name} src={logo.src} alt={logo.name} width={36} height={36} />
            ))}
          </div>
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: 67,
          bottom: 44,
          display: "flex",
          alignItems: "center",
          gap: 12,
          color: "#575e57",
          fontSize: 21,
          letterSpacing: -0.3,
        }}
      >
        <div style={{ width: 25, height: 1, backgroundColor: "#92988f" }} />
        openship.io
      </div>
    </div>,
    { ...OG_SIZE, fonts: [{ name: "Gellix", data: await font, weight: 500, style: "normal" }] },
  );
}
