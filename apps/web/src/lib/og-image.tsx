import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT =
  "Openship - Open Source, Self-Hostable Deployment Platform";

/** Accent palette for the aurora glow, footer dot, and eyebrow tint.
 *  `glow` is a bare "r,g,b" triple (used inside rgba()). Defaults to brand green. */
export interface OgAccent {
  glow: string;
  solid: string;
  soft: string;
}

const GREEN_ACCENT: OgAccent = { glow: "57,174,74", solid: "#39AE4A", soft: "#A3E1B3" };

interface OgOptions {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  accent?: OgAccent;
}

export function renderOgImage({
  title = "Deploy anything. Own everything.",
  subtitle = "Open source, self-hostable deployment platform. AI-powered builds. Free SSL. Instant rollback.",
  eyebrow,
  accent = GREEN_ACCENT,
}: OgOptions = {}) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0F0F0F",
          color: "#FFFFFF",
          padding: "72px 80px",
          fontFamily: "system-ui, -apple-system, sans-serif",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(1200px 600px at 80% 0%, rgba(${accent.glow},.18), transparent 60%), radial-gradient(900px 500px at 0% 100%, rgba(${accent.glow},.10), transparent 65%)`,
          }}
        />

        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 18,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 999,
              border: "4px solid #FFFFFF",
            }}
          />
          <div style={{ fontSize: 36, fontWeight: 600, letterSpacing: -0.5 }}>
            Openship
          </div>
        </div>

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
          {eyebrow && (
            <div
              style={{
                fontSize: 22,
                fontWeight: 500,
                color: accent.soft,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              {eyebrow}
            </div>
          )}
          <div
            style={{
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1.04,
              letterSpacing: -2.2,
              color: "#FFFFFF",
              maxWidth: 1040,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 28,
              lineHeight: 1.35,
              color: "rgba(255,255,255,0.72)",
              maxWidth: 980,
            }}
          >
            {subtitle}
          </div>
        </div>

        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: "rgba(255,255,255,0.55)",
            fontSize: 22,
          }}
        >
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 999,
                background: accent.solid,
              }}
            />
            openship.io
          </div>
          <div style={{ display: "flex", gap: 28 }}>
            <span>github.com/oblien/openship</span>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
