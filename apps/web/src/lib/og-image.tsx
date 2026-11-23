import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CSSProperties } from "react";
import type { FeatureIllustrationName } from "@repo/ui/illustrations";
import { ImageResponse } from "next/og";
import { homeArtwork, svgImage } from "./og-art";
import { objectArtwork, type CoverObject } from "./og-objects";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT = "OpenShip. Deploy anything. Own everything.";

type Mark = { name: string; src?: string };
type Illustration =
  | { object: CoverObject }
  | { feature: FeatureIllustrationName }
  | { marks: readonly Mark[]; relation?: "transfer" | "compare" };
type Art =
  | Illustration
  | { outline: readonly string[]; feature?: FeatureIllustrationName }
  | { command: string; subcommands: readonly string[] }
  | { version: string; changes: readonly number[] };

export interface ShareCard {
  title: string;
  secondLine?: string;
  subtitle?: string;
  eyebrow?: string;
  art: Art;
  layout?: "spread" | "reverse" | "masthead";
  footer?: string;
}

const field = svgImage(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="630">
  <defs>
    <pattern id="dot" width="15" height="15" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#9b979f"/></pattern>
    <radialGradient id="fade"><stop stop-color="white"/><stop offset=".69" stop-color="#999"/><stop offset="1" stop-color="black"/></radialGradient>
    <mask id="mask"><ellipse cx="325" cy="318" rx="290" ry="294" fill="url(#fade)"/></mask>
  </defs>
  <path d="M0 0h600v630H0z" fill="url(#dot)" mask="url(#mask)" opacity=".6"/>
</svg>`);

let font: Promise<Buffer> | undefined;
let features: Promise<Record<FeatureIllustrationName, string>> | undefined;
async function featureSrc(name: FeatureIllustrationName) {
  features ??= readFile(join(process.cwd(), ".share-feature-art.json"), "utf8").then(JSON.parse);
  return svgImage((await features)[name]);
}

const canvas: CSSProperties = {
  ...OG_SIZE,
  display: "flex",
  position: "absolute",
  left: 0,
  top: 0,
};
const paper = "#f8f8f5";
const row: CSSProperties = { display: "flex", alignItems: "center" };
const column: CSSProperties = { display: "flex", flexDirection: "column" };
function Wordmark({ section }: { section?: string }) {
  return (
    <div style={{ position: "absolute", top: 52, left: 65, ...row, gap: 12 }}>
      <div style={{ width: 31, height: 31, border: "4px solid #171918", borderRadius: 32 }} />
      <div style={{ fontSize: 34, letterSpacing: -1.7, lineHeight: 1 }}>OpenShip</div>
      {section && (
        <div
          style={{
            ...row,
            borderLeft: "1px solid #c8cac4",
            marginLeft: 8,
            paddingLeft: 18,
            color: "#565b57",
            fontSize: 23,
          }}
        >
          {section}
        </div>
      )}
    </div>
  );
}

function Caption({
  title,
  secondLine,
  subtitle,
  width,
  size,
  subWidth = width,
}: {
  title: string;
  secondLine?: string;
  subtitle?: string;
  width: number;
  size: number;
  subWidth?: number;
}) {
  return (
    <div style={{ ...column, width }}>
      <div style={{ ...column, fontSize: size, lineHeight: 1.02, letterSpacing: -size * 0.055 }}>
        <span style={{ lineClamp: 3 }}>{title}</span>
        {secondLine && <span style={{ color: "#636863" }}>{secondLine}</span>}
      </div>
      {subtitle && (
        <div
          style={{
            display: "block",
            whiteSpace: "pre-wrap",
            width: subWidth,
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
    </div>
  );
}

function Home() {
  return (
    <div style={canvas}>
      <img
        src={field}
        width={600}
        height={630}
        style={{ position: "absolute", right: 0, top: 0 }}
      />
      <img
        src={svgImage(homeArtwork())}
        width={547}
        height={527}
        style={{ position: "absolute", right: 18, top: 62 }}
      />
      <Wordmark />
      <div
        style={{
          ...column,
          justifyContent: "center",
          position: "absolute",
          top: 120,
          bottom: 86,
          left: 64,
          width: 634,
        }}
      >
        <Caption
          title="Deploy anything."
          secondLine="Own everything."
          subtitle={"Run your apps on OpenShip Cloud\nor your own servers."}
          width={634}
          subWidth={572}
          size={81}
        />
      </div>
    </div>
  );
}

function BrandStrip({
  marks,
  relation,
}: {
  marks: readonly Mark[];
  relation?: "transfer" | "compare";
}) {
  const size = marks.length > 2 ? 49 : relation ? 81 : 155;
  return (
    <div style={{ ...row, gap: 18, justifyContent: "center" }}>
      {marks.map(({ name, src }) =>
        src ? (
          <img key={name} src={src} width={size} height={size} style={{ objectFit: "contain" }} />
        ) : (
          <span
            key={name}
            style={{
              fontSize: Math.min(94, 540 / Math.max(7, name.length)),
              letterSpacing: -2,
              lineHeight: 1,
              textAlign: "center",
              maxWidth: relation ? 250 : 370,
            }}
          >
            {name}
          </span>
        ),
      )}
      {relation && (
        <>
          <svg
            width="44"
            height="44"
            viewBox="0 0 44 44"
            fill="none"
            stroke="#929a90"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d={relation === "transfer" ? "M3 22h36M27 10l12 12-12 12" : "m10 10 24 24m0-24L10 34"}
            />
          </svg>
          <div style={{ width: 75, height: 75, borderRadius: 50, border: "9px solid #30342f" }} />
        </>
      )}
    </div>
  );
}

async function IllustratedCard(card: ShareCard, art: Illustration) {
  const isMasthead = card.layout === "masthead";
  const reverse = card.layout === "reverse";
  const width = isMasthead ? 1058 : 620;
  const titleSize = card.secondLine
    ? 78
    : card.title.length > 62
      ? 54
      : card.title.length > 36
        ? 64
        : 78;
  const artWidth = isMasthead ? 238 : 405;
  const artHeight = isMasthead ? 184 : 335;
  let subject;
  if ("marks" in art) subject = <BrandStrip {...art} />;
  else {
    const src =
      "object" in art ? svgImage(objectArtwork(art.object)) : await featureSrc(art.feature);
    subject = (
      <img src={src} width={artWidth} height={artHeight} style={{ objectFit: "contain" }} />
    );
  }
  return (
    <div style={canvas}>
      <Wordmark section={card.eyebrow} />
      <div
        style={{
          ...row,
          justifyContent: "center",
          position: "absolute",
          left: isMasthead ? 845 : reverse ? 58 : 725,
          top: isMasthead ? 69 : 135,
          width: isMasthead ? 269 : 420,
          height: isMasthead ? 180 : 362,
        }}
      >
        {subject}
      </div>
      <div
        style={{
          ...column,
          justifyContent: "center",
          position: "absolute",
          left: reverse ? 508 : 65,
          top: isMasthead ? 246 : 125,
          bottom: 89,
          width,
        }}
      >
        <Caption
          {...card}
          width={width}
          subWidth={isMasthead ? 920 : width - 10}
          size={titleSize}
        />
      </div>
    </div>
  );
}

async function DocumentCover({
  card,
  art,
}: {
  card: ShareCard;
  art: Extract<Art, { outline: readonly string[] }>;
}) {
  // The outline supplies the geometry of the index tabs for guides without an
  // assigned feature illustration. Longer headings extend further along the edge.
  const rows = art.outline.slice(0, 10);
  const height = 130 / Math.max(1, rows.length);
  const tabs = rows
    .map(
      (label, i) =>
        `<rect x="8" y="${8 + i * height}" width="${40 + Math.min(115, label.length * 2.7)}" height="${Math.min(26, height - 2)}" rx="3" fill="${i === 0 ? "#aca0bf" : i % 2 ? "#bbc4bb" : "#686f67"}"/>`,
    )
    .join("");
  const illustrated = art.feature
    ? await featureSrc(art.feature)
    : svgImage(`<svg xmlns="http://www.w3.org/2000/svg" width="172" height="146">${tabs}</svg>`);
  return (
    <div style={canvas}>
      <Wordmark section={card.eyebrow} />
      {illustrated && (
        <img
          src={illustrated}
          width={198}
          height={158}
          style={{ position: "absolute", top: 117, right: 69 }}
        />
      )}
      <div style={{ position: "absolute", left: 65, top: 154, ...column }}>
        <Caption {...card} width={824} size={card.title.length > 50 ? 62 : 78} subWidth={840} />
      </div>
      {!!art.outline.length && (
        <div
          style={{
            ...row,
            position: "absolute",
            left: 65,
            right: 65,
            bottom: 101,
            gap: 26,
            alignItems: "flex-start",
          }}
        >
          {art.outline.slice(0, 3).map((title, i) => (
            <div
              key={i}
              style={{
                ...column,
                flex: 1,
                borderTop: "2px solid #c7cbc5",
                paddingTop: 10,
                color: "#515851",
                fontSize: 20,
                lineHeight: 1.15,
              }}
            >
              <span style={{ lineClamp: 2 }}>{title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandCover({ card, art }: { card: ShareCard; art: Extract<Art, { command: string }> }) {
  const { command, subcommands } = art;
  return (
    <div style={canvas}>
      <Wordmark section={card.eyebrow} />
      <div
        style={{
          position: "absolute",
          left: 65,
          right: 65,
          top: 149,
          bottom: 115,
          justifyContent: "center",
          ...column,
        }}
      >
        <div style={{ ...row, gap: 14, fontSize: 29, color: "#58665b" }}>
          <span style={{ color: "#899b8a" }}>$</span>openship
        </div>
        <div style={{ ...row, gap: 16, marginTop: 8 }}>
          <span
            style={{
              fontSize: command.length > 31 ? 66 : 92,
              lineHeight: 1.04,
              letterSpacing: -4,
              maxWidth: 1000,
            }}
          >
            {command}
          </span>
          <span style={{ width: 13, height: 59, backgroundColor: "#a5bca5" }} />
        </div>
        {!!subcommands.length && (
          <div style={{ ...row, gap: 22, color: "#5d6c5b", fontSize: 22, marginTop: 22 }}>
            {subcommands.slice(0, 5).map((name) => (
              <span key={name} style={{ borderTop: "2px solid #b7c2b1", paddingTop: 8 }}>
                {name}
              </span>
            ))}
          </div>
        )}
        {card.subtitle && !subcommands.length && (
          <span style={{ marginTop: 32, fontSize: 26, color: "#555c57", lineClamp: 2 }}>
            {card.subtitle}
          </span>
        )}
      </div>
    </div>
  );
}

function ReleaseCover({ card, art }: { card: ShareCard; art: Extract<Art, { version: string }> }) {
  const peak = Math.max(1, ...art.changes);
  return (
    <div style={canvas}>
      <Wordmark section={card.eyebrow} />
      <div style={{ ...column, position: "absolute", left: 65, top: 175, width: 805 }}>
        <Caption title={art.version} subtitle={card.subtitle} size={124} width={790} />
      </div>
      <div
        style={{
          ...row,
          alignItems: "flex-end",
          justifyContent: "flex-end",
          gap: 9,
          position: "absolute",
          right: 65,
          bottom: 95,
          height: 188,
        }}
      >
        {art.changes.slice(0, 8).map((n, i) => (
          <div
            key={i}
            style={{
              width: 16,
              height: 6 + (176 * n) / peak,
              backgroundColor: i === 0 ? "#9c8cad" : "#bfc6bd",
              borderRadius: 8,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export async function renderOgImage(card?: ShareCard) {
  font ??= readFile(join(process.cwd(), "src/lib/og-fonts/Gellix-Medium.woff"));
  let body;
  if (!card) body = <Home />;
  else if ("command" in card.art) body = <CommandCover card={card} art={card.art} />;
  else if ("version" in card.art) body = <ReleaseCover card={card} art={card.art} />;
  else if ("outline" in card.art) body = await DocumentCover({ card, art: card.art });
  else body = await IllustratedCard(card, card.art);
  return new ImageResponse(
    <div
      style={{
        ...OG_SIZE,
        display: "flex",
        backgroundColor: paper,
        color: "#161918",
        fontFamily: "Gellix",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {body}
      <div
        style={{
          position: "absolute",
          left: 67,
          bottom: 44,
          ...row,
          gap: 12,
          color: "#575e57",
          fontSize: 21,
          letterSpacing: -0.3,
        }}
      >
        <div style={{ width: 25, height: 1, backgroundColor: "#92988f" }} />
        {card?.footer || "openship.io"}
      </div>
    </div>,
    { ...OG_SIZE, fonts: [{ name: "Gellix", data: await font, weight: 500, style: "normal" }] },
  );
}
