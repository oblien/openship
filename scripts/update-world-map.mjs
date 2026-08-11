#!/usr/bin/env node
/**
 * Regenerate the vendored world-map path data behind the Monitoring tab's
 * visitors-by-country choropleth.
 *
 * Why vendored at all: the dashboard has no mapping library, and a choropleth
 * needs exactly one thing — a country outline per ISO-3166-1 alpha-2 code. Pulling
 * in d3-geo + topojson + a TopoJSON asset to produce that at runtime would add
 * three dependencies and a second theming surface for a static picture. So this
 * script does the projection ONCE, at maintainer time, and commits plain SVG path
 * strings. Same reasoning (and the same "our copy is what ships") as the vendored
 * GeoLite2 database next door — see scripts/update-geoip.mjs.
 *
 * Source: world-atlas (Natural Earth, public domain), 110m resolution — the right
 * detail level for a card-sized map, and small enough to commit.
 *
 * Projection: equirectangular, computed here with no dependencies. Longitude and
 * latitude map linearly to x and y, so the output is a plain 360x180 viewBox that
 * needs no projection code in the client.
 *
 * Usage:
 *   node scripts/update-world-map.mjs
 *   WORLD_ATLAS_URL=<url> node scripts/update-world-map.mjs
 *
 * Commit the resulting file.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ATLAS =
  process.env.WORLD_ATLAS_URL?.trim() ||
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

// ISO 3166-1 numeric → alpha-2. Natural Earth keys countries by numeric id, but
// every consumer here (GeoLite2, the edge's `g:` keys, the API response) speaks
// alpha-2, so the mapping is resolved at generation time.
const NUMERIC_TO_ALPHA2 = {
  4:"AF",8:"AL",12:"DZ",16:"AS",20:"AD",24:"AO",28:"AG",31:"AZ",32:"AR",36:"AU",40:"AT",
  44:"BS",48:"BH",50:"BD",51:"AM",52:"BB",56:"BE",60:"BM",64:"BT",68:"BO",70:"BA",72:"BW",
  74:"BV",76:"BR",84:"BZ",86:"IO",90:"SB",92:"VG",96:"BN",100:"BG",104:"MM",108:"BI",
  112:"BY",116:"KH",120:"CM",124:"CA",132:"CV",136:"KY",140:"CF",144:"LK",148:"TD",
  152:"CL",156:"CN",158:"TW",162:"CX",166:"CC",170:"CO",174:"KM",175:"YT",178:"CG",
  180:"CD",184:"CK",188:"CR",191:"HR",192:"CU",196:"CY",203:"CZ",204:"BJ",208:"DK",
  212:"DM",214:"DO",218:"EC",222:"SV",226:"GQ",231:"ET",232:"ER",233:"EE",234:"FO",
  238:"FK",239:"GS",242:"FJ",246:"FI",248:"AX",250:"FR",254:"GF",258:"PF",260:"TF",
  262:"DJ",266:"GA",268:"GE",270:"GM",275:"PS",276:"DE",288:"GH",292:"GI",296:"KI",
  300:"GR",304:"GL",308:"GD",312:"GP",316:"GU",320:"GT",324:"GN",328:"GY",332:"HT",
  334:"HM",336:"VA",340:"HN",344:"HK",348:"HU",352:"IS",356:"IN",360:"ID",364:"IR",
  368:"IQ",372:"IE",376:"IL",380:"IT",384:"CI",388:"JM",392:"JP",398:"KZ",400:"JO",
  404:"KE",408:"KP",410:"KR",414:"KW",417:"KG",418:"LA",422:"LB",426:"LS",428:"LV",
  430:"LR",434:"LY",438:"LI",440:"LT",442:"LU",446:"MO",450:"MG",454:"MW",458:"MY",
  462:"MV",466:"ML",470:"MT",474:"MQ",478:"MR",480:"MU",484:"MX",492:"MC",496:"MN",
  498:"MD",499:"ME",500:"MS",504:"MA",508:"MZ",512:"OM",516:"NA",520:"NR",524:"NP",
  528:"NL",531:"CW",533:"AW",534:"SX",535:"BQ",540:"NC",548:"VU",554:"NZ",558:"NI",
  562:"NE",566:"NG",570:"NU",574:"NF",578:"NO",580:"MP",581:"UM",583:"FM",584:"MH",
  585:"PW",586:"PK",591:"PA",598:"PG",600:"PY",604:"PE",608:"PH",612:"PN",616:"PL",
  620:"PT",624:"GW",626:"TL",630:"PR",634:"QA",638:"RE",642:"RO",643:"RU",646:"RW",
  652:"BL",654:"SH",659:"KN",660:"AI",662:"LC",663:"MF",666:"PM",670:"VC",674:"SM",
  678:"ST",682:"SA",686:"SN",688:"RS",690:"SC",694:"SL",702:"SG",703:"SK",704:"VN",
  705:"SI",706:"SO",710:"ZA",716:"ZW",724:"ES",728:"SS",729:"SD",732:"EH",740:"SR",
  744:"SJ",748:"SZ",752:"SE",756:"CH",760:"SY",762:"TJ",764:"TH",768:"TG",772:"TK",
  776:"TO",780:"TT",784:"AE",788:"TN",792:"TR",795:"TM",796:"TC",798:"TV",800:"UG",
  804:"UA",807:"MK",818:"EG",826:"GB",831:"GG",832:"JE",833:"IM",834:"TZ",840:"US",
  850:"VI",854:"BF",858:"UY",860:"UZ",862:"VE",876:"WF",882:"WS",887:"YE",894:"ZM",
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(
  repoRoot, "apps", "dashboard", "src", "components", "monitoring", "country-paths.json",
);

/** Decode TopoJSON's delta+quantized arc encoding into absolute [lon, lat] pairs. */
function decodeArc(arc, transform) {
  const { scale: [sx, sy], translate: [tx, ty] } = transform;
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * sx + tx, y * sy + ty];
  });
}

/** Equirectangular: lon/lat straight to a 360x180 viewBox with y flipped. */
const projX = (lon) => lon + 180;
const projY = (lat) => 90 - lat;

function ringToPath(ring) {
  // Subpaths, not one: a ring that crosses the antimeridian has to be CUT there.
  // Chukotka (Russia) and the Aleutians (US) both wrap, and in an equirectangular
  // projection the wrap shows up as consecutive points ~360 apart in x. Joining
  // them with an `L` draws a band straight across the map — which, filled, paints
  // the entire world in that country's colour.
  const subpaths = [];
  let cur = "";
  let prevX = null;
  let prevY = null;
  let prevLon = null;

  const flush = () => {
    // A stub of one or two points has no area to fill.
    if (cur && cur.split(/[ML]/).length > 3) subpaths.push(`${cur}Z`);
    cur = "";
    prevX = null;
    prevY = null;
  };

  for (const [lon, lat] of ring) {
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) flush();
    prevLon = lon;
    const x = Math.round(projX(lon) * 100) / 100;
    const y = Math.round(projY(lat) * 100) / 100;
    // Drop points that round to the same place — at 110m most of the payload is
    // sub-pixel detail that no card-sized render can show.
    if (x === prevX && y === prevY) continue;
    cur += `${cur === "" ? "M" : "L"}${x} ${y}`;
    prevX = x;
    prevY = y;
  }
  flush();
  return subpaths.join("");
}

function arcsToRing(arcIndexes, arcs) {
  const ring = [];
  for (const idx of arcIndexes) {
    // A negative index means "traverse this arc backwards"; ~i is the real index.
    const reversed = idx < 0;
    const arc = arcs[reversed ? ~idx : idx];
    const pts = reversed ? [...arc].reverse() : arc;
    // Arcs share endpoints, so skip the duplicated join point.
    ring.push(...(ring.length ? pts.slice(1) : pts));
  }
  return ring;
}

console.log(`Fetching world atlas from ${ATLAS} ...`);
const res = await fetch(ATLAS);
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
const topo = await res.json();
const objects = topo.objects?.countries;
if (!objects?.geometries?.length) {
  console.error("Unexpected atlas shape: objects.countries.geometries missing");
  process.exit(1);
}

const arcs = topo.arcs.map((a) => decodeArc(a, topo.transform));
const paths = {};
let skipped = 0;

for (const geom of objects.geometries) {
  const alpha2 = NUMERIC_TO_ALPHA2[Number(geom.id)];
  if (!alpha2) {
    skipped++;
    continue;
  }
  // Polygon = one outer ring (+ holes); MultiPolygon = many. Both flatten to a
  // single path string — fill-rule evenodd on the client renders holes correctly.
  const polygons =
    geom.type === "Polygon" ? [geom.arcs] : geom.type === "MultiPolygon" ? geom.arcs : [];
  let d = "";
  for (const poly of polygons) {
    for (const ringArcs of poly) d += ringToPath(arcsToRing(ringArcs, arcs));
  }
  if (d) paths[alpha2] = (paths[alpha2] ?? "") + d;
}

const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
const payload = {
  _source: "world-atlas countries-110m (Natural Earth, public domain)",
  _projection: "equirectangular, viewBox 0 0 360 180",
  _generatedBy: "scripts/update-world-map.mjs",
  paths: sorted,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(payload)}\n`);
const bytes = (await import("node:fs")).statSync(OUT).size;
console.log(
  `Wrote ${OUT}\n  ${Object.keys(sorted).length} countries, ${(bytes / 1024).toFixed(0)} KB` +
    (skipped ? `\n  ${skipped} geometries skipped (no ISO alpha-2 mapping)` : ""),
);
