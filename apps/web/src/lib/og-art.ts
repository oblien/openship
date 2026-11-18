// The engraved server is the homepage illustration.
const face = "M23 0H223Q246 0 246 23V201Q246 224 223 224H23Q0 224 0 201V23Q0 0 23 0Z";

function plate(y: number, depth: number, top: string, side: string, trim: string, detail = "") {
  const plane = (height: number) => `matrix(.99 .46 -.80 .49 242 ${height})`;
  // Stack identical projected outlines along the vertical axis. The same
  // gradient on every slice gives a continuous edge around all four corners.
  const edge = Array.from(
    { length: depth },
    (_, i) => `<path d="${face}" transform="${plane(y + depth - i)}" fill="${side}"/>`,
  ).join("");
  return `<g>${edge}<g transform="${plane(y)}"><path d="${face}" fill="${top}" stroke="${trim}" stroke-width="1.7"/>${detail}</g></g>`;
}

export function homeArtwork() {
  const light = "#c2b4f5";
  const slots = Array.from(
    { length: 9 },
    (_, i) => `<rect x="${76 + i * 11}" y="182" width="5.4" height="17" rx="2.7" fill="#989b95"/>`,
  ).join("");
  const bolts = [
    [19, 19],
    [227, 19],
    [19, 204],
    [227, 204],
  ]
    .map(
      ([x, y]) =>
        `<circle cx="${x}" cy="${y}" r="3.5" fill="#a9aba5"/><path d="m${x - 1.4} ${y + 1.4} 2.8-2.8" stroke="#ededeb" stroke-width="1"/>`,
    )
    .join("");
  const lid = `<rect x="8" y="8" width="230" height="208" rx="16" fill="none" stroke="#fff" stroke-opacity=".8"/>${bolts}<circle cx="123" cy="110" r="48" fill="none" stroke="url(#graphite)" stroke-width="15"/>${slots}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="520" viewBox="0 0 540 520">
    <defs>
      <linearGradient id="lid" x2=".9" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#fffefa"/><stop offset=".56" stop-color="#f0f0eb"/><stop offset="1" stop-color="#dcded8"/></linearGradient>
      <linearGradient id="steel"><stop stop-color="#bebfba"/><stop offset=".50" stop-color="#dedfda"/><stop offset=".54" stop-color="#b4b7b1"/><stop offset="1" stop-color="#9b9e99"/></linearGradient>
      <linearGradient id="graphite" x2=".8" y2="1"><stop stop-color="#15191a"/><stop offset="1" stop-color="#424647"/></linearGradient>
      <linearGradient id="base"><stop stop-color="#525658"/><stop offset=".51" stop-color="#303436"/><stop offset="1" stop-color="#141718"/></linearGradient>
      <linearGradient id="glass"><stop stop-color="#e4e1ec"/><stop offset=".52" stop-color="${light}"/><stop offset="1" stop-color="#e7e6eb"/></linearGradient>
      <linearGradient id="rim"><stop stop-color="#9c99a6"/><stop offset=".54" stop-color="${light}"/><stop offset="1" stop-color="#83828e"/></linearGradient>
      <radialGradient id="shadow"><stop stop-color="#363539" stop-opacity=".24"/><stop offset=".55" stop-color="#59585a" stop-opacity=".11"/><stop offset="1" stop-color="#646469" stop-opacity="0"/></radialGradient>
    </defs>
    <ellipse cx="277" cy="422" rx="222" ry="62" fill="url(#shadow)"/>
    ${plate(174, 33, "url(#graphite)", "url(#base)", "#64666a")}
    <g transform="matrix(.99 .46 0 1 89 305)" fill="#181c1d">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${i * 12}" y="0" width="7" height="7" rx="2"/>`).join("")}</g>
    <path d="m358 384 22-13" stroke="${light}" stroke-linecap="round" stroke-width="3.5"/>
    ${plate(126, 14, "url(#glass)", "url(#rim)", "#eeedf3")}
    ${plate(55, 29, "url(#lid)", "url(#steel)", "#cdcec9", lid)}
  </svg>`;
}

export function svgImage(svg: string) {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
