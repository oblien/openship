import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { format, resolveConfig } from "prettier";
import { FEATURES, CATEGORY_ORDER, type Feature } from "../apps/web/src/lib/features";
import appearance from "../packages/core/src/appearance-defaults.json";
import { FeatureIllustration } from "../packages/ui/src/illustrations/FeatureIllustration";
import { featureArtwork } from "../packages/ui/src/illustrations/artwork";

// Validate the same catalog and artwork that the actual feature pages render.
const artworkNames = new Set(Object.keys(featureArtwork));
const featureNames = new Set(FEATURES.map((feature) => feature.slug));
for (const feature of FEATURES) {
  if (!artworkNames.has(feature.slug)) throw new Error(`Missing illustration: ${feature.slug}`);
}
for (const name of artworkNames) {
  if (!featureNames.has(name as Feature["slug"]))
    throw new Error(`Unknown feature illustration: ${name}`);
}

function Card({ feature }: { feature: Feature }) {
  return (
    <article
      className="feature-card"
      data-feature={feature.slug}
      data-search={`${feature.title} ${feature.tagline} ${feature.category}`.toLowerCase()}
    >
      <div className="art-stage">
        <FeatureIllustration name={feature.slug} className="feature-art" />
      </div>
      <div className="feature-copy">
        <h4>{feature.title}</h4>
        <p>{feature.tagline}</p>
      </div>
      <span className="state-label">{feature.slug}</span>
    </article>
  );
}

const body = renderToStaticMarkup(
  <>
    <header className="wrap brand-bar">
      <a href="index.html" className="brand">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="13.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
        </svg>
        Openship
      </a>
      <a href="feature-section.html" className="site-link">
        Original section reference ↗
      </a>
    </header>
    <div className="wrap intro">
      <p className="eyebrow">Product artwork</p>
      <h1>Illustration library.</h1>
      <p>
        {FEATURES.length} shared illustrations. The same SVG source used by the website and app.
      </p>
    </div>
    <div className="toolbar">
      <div className="wrap toolbar-inner">
        <a href="../../illustrations.md" className="site-link">
          Generation and design guide ↗
        </a>
        <div className="controls">
          <div className="segmented" role="group" aria-label="Preview surface">
            {["Website", "Dark", "Dim", "Light"].map((label) => (
              <button
                type="button"
                key={label}
                data-theme={label.toLowerCase()}
                aria-pressed={label === "Website"}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Illustration height">
            {[44, 56, 72].map((size) => (
              <button
                type="button"
                key={size}
                data-size={size}
                aria-label={`${size} pixels high`}
                aria-pressed={size === 56}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
    <main className="wrap">
      <div className="search-row">
        <p id="result-count" role="status" aria-live="polite">
          {FEATURES.length} feature illustrations
        </p>
        <label className="search">
          <span className="sr-only">Find a feature</span>
          <input type="search" id="search" placeholder="Find a feature" autoComplete="off" />
        </label>
      </div>
      <section id="catalog" className="collection" aria-labelledby="catalog-title">
        <div className="section-heading">
          <h2 id="catalog-title">Feature collection</h2>
          <span>Shared production artwork</span>
        </div>
        <nav className="category-links" aria-label="Feature categories">
          {CATEGORY_ORDER.map((category) => (
            <a key={category} href={`#category-${category.toLowerCase()}`}>
              {category}
            </a>
          ))}
        </nav>
        {CATEGORY_ORDER.map((category) => (
          <section
            className="category"
            key={category}
            id={`category-${category.toLowerCase()}`}
            aria-labelledby={`title-${category.toLowerCase()}`}
          >
            <h3 id={`title-${category.toLowerCase()}`}>{category}</h3>
            <div className="grid">
              {FEATURES.filter((feature) => feature.category === category).map((feature) => (
                <Card key={feature.slug} feature={feature} />
              ))}
            </div>
          </section>
        ))}
      </section>
      <p id="empty" hidden>
        No matching features. Try another search.
      </p>
    </main>
    <footer className="wrap">
      Flat SVG · foreground layers · small warm accents
      <span>Approved artwork is rendered from @repo/ui/illustrations</span>
    </footer>
  </>,
);

const themeCss = (["dark", "dim", "light"] as const)
  .map((mode) => {
    const palette = appearance[mode];
    return `:root[data-theme="${mode}"] {
    --page:${palette["--th-bg-page"]}; --card:${palette["--th-card-bg-solid"]};
    --text:${palette["--th-text-title"]}; --muted:${palette["--th-text-body"]};
    --border:${palette["--th-bd-default"]}; --art-ink:${palette["--th-text-title"]};
    --illustration-surface:var(--card); --illustration-cutout:var(--card);
    ${mode === "light" ? "color-scheme:light; --illustration-accent:#a96c21; --illustration-accent-ink:#fff; --control:#00000006; --selected:#15151c; --selected-text:#fff;" : ""}
  }`;
  })
  .join("\n");

const css = `
@font-face{font-family:Gellix;src:url('https://cdn.oblien.com/fonts/Gellix-Regular.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:Gellix;src:url('https://cdn.oblien.com/fonts/Gellix-Medium.woff2') format('woff2');font-weight:500;font-display:swap}
:root{color-scheme:dark;--page:#0c0d12;--card:#15151c;--text:#f1f0f5;--muted:#9b99a4;--border:#ffffff16;--art-ink:#f1f0f5;--control:#ffffff08;--selected:#f1f0f5;--selected-text:#15151c;--art-height:56px;--art-width:70px}
${themeCss}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font-family:Gellix,system-ui,sans-serif;-webkit-font-smoothing:antialiased}h1,h2,h3,h4,p{margin:0}a{color:inherit;text-decoration:none}button,input{font:inherit}button{cursor:pointer}:focus-visible{outline:2px solid var(--text);outline-offset:4px}.wrap{width:min(1160px,calc(100% - 64px));margin-inline:auto}.brand-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-block:24px;border-bottom:1px solid var(--border)}.brand{display:flex;gap:10px;align-items:center;font-size:20px;font-weight:500;letter-spacing:-.6px}.brand svg{width:28px;height:28px}.site-link{font-size:13px;color:var(--muted)}.site-link:hover{color:var(--text)}.intro{padding-block:45px 32px}.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}h1{margin-top:14px;font-size:clamp(34px,5vw,49px);font-weight:500;line-height:1.1;letter-spacing:-.04em}.intro>p:last-child{margin-top:17px;color:var(--muted);font-size:15px;line-height:1.6}.toolbar{position:sticky;top:0;z-index:5;background:var(--page);border-block:1px solid var(--border)}.toolbar-inner{display:flex;justify-content:space-between;align-items:center;gap:20px;padding-block:13px}.toolbar nav{display:flex;gap:24px;font-size:13px}.toolbar nav span{color:var(--muted);margin-left:5px}.controls{display:flex;gap:14px}.segmented{display:flex;gap:2px;padding:3px;background:var(--control);border-radius:10px}.segmented button{border:0;background:none;color:var(--muted);padding:7px 10px;border-radius:7px;font-size:12px;min-height:32px}.segmented button[aria-pressed=true]{background:var(--selected);color:var(--selected-text)}main{padding-block:28px 48px}.search-row{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:28px;font-size:13px;color:var(--muted)}.search input{width:240px;padding:11px 14px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px}.search input::placeholder{color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.collection,.category{scroll-margin-top:95px}.collection+.collection{margin-top:46px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}.section-heading h2{font-weight:500;font-size:24px;letter-spacing:-.03em}.section-heading span{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.feature-card{display:flex;flex-direction:column;min-width:0;padding:22px;background:var(--card);border:1px solid var(--border);border-radius:20px}.art-stage{height:86px;display:flex;align-items:center;color:var(--art-ink)}.feature-art{display:block;width:var(--art-width);height:var(--art-height);flex-shrink:0}.feature-copy{margin-top:12px;flex:1}.feature-copy h4{font-size:15px;font-weight:500;line-height:1.4}.feature-copy p{margin-top:8px;font-size:12px;line-height:1.6;color:var(--muted)}.state-label{display:block;margin-top:20px;font-size:10px;letter-spacing:.04em;color:var(--muted)}.category-links{display:flex;flex-wrap:wrap;gap:12px 24px;color:var(--muted);font-size:12px;margin-bottom:26px}.category-links a:hover{color:var(--text)}.category+.category{margin-top:28px}.category h3{font-size:14px;font-weight:500;margin-bottom:14px;color:var(--muted)}[hidden]{display:none!important}#empty{padding:60px 10px;text-align:center;color:var(--muted)}footer{display:flex;justify-content:space-between;gap:24px;border-top:1px solid var(--border);padding-block:22px 34px;font-size:11px;color:var(--muted)}
@media(max-width:1000px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}.toolbar nav{gap:16px}.controls{gap:8px}}
@media(max-width:760px){.wrap{width:calc(100% - 40px)}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.toolbar-inner{flex-wrap:wrap;gap:10px}.toolbar nav{width:100%;justify-content:space-between}.controls{width:100%;justify-content:space-between}.collection,.category{scroll-margin-top:125px}.section-heading{align-items:start;flex-direction:column;gap:8px}.feature-card{padding:19px}.search input{width:200px}footer{flex-direction:column;gap:8px}}
@media(max-width:480px){.wrap{width:calc(100% - 32px)}.brand{font-size:18px}.brand svg{width:24px;height:24px}.intro{padding-block:32px 25px}.search-row{flex-direction:column;align-items:stretch;gap:14px}.search input{width:100%}.segmented button{padding-inline:8px;font-size:11px}.grid{grid-template-columns:1fr}.feature-card{display:grid;grid-template-columns:94px minmax(0,1fr);gap:0 14px;padding:18px}.art-stage{grid-row:span 2;justify-content:center;height:82px}.feature-copy{margin-top:3px}.state-label{grid-column:2;margin-top:12px}.feature-copy h4{font-size:14px}.controls{gap:6px}}
`;

const script = `
for(const button of document.querySelectorAll('button[data-theme]'))button.addEventListener('click',()=>{document.documentElement.dataset.theme=button.dataset.theme;for(const option of document.querySelectorAll('button[data-theme]'))option.setAttribute('aria-pressed',String(option===button));});
for(const button of document.querySelectorAll('button[data-size]'))button.addEventListener('click',()=>{const height=Number(button.dataset.size);document.documentElement.style.setProperty('--art-height',height+'px');document.documentElement.style.setProperty('--art-width',height*1.25+'px');for(const option of document.querySelectorAll('button[data-size]'))option.setAttribute('aria-pressed',String(option===button));});
document.querySelector('#search').addEventListener('input',event=>{const query=event.target.value.trim().toLowerCase();let count=0;for(const card of document.querySelectorAll('.feature-card')){card.hidden=!card.dataset.search.includes(query);if(!card.hidden)count++;}for(const category of document.querySelectorAll('.category')){category.hidden=!category.querySelector('.feature-card:not([hidden])');document.querySelector('[href="#'+category.id+'"]').hidden=category.hidden;}for(const collection of document.querySelectorAll('.collection'))collection.hidden=!collection.querySelector('.feature-card:not([hidden])');document.querySelector('#empty').hidden=count>0;document.querySelector('#result-count').textContent=query?count+' of ${FEATURES.length} feature illustrations':'${FEATURES.length} feature illustrations';});
`;

const directory = new URL("../docs/design/illustrations/", import.meta.url);
await mkdir(directory, { recursive: true });
const destination = new URL("index.html", directory);
const formatting = await resolveConfig(fileURLToPath(destination));
await writeFile(
  destination,
  await format(
    `<!doctype html><!-- Generated by scripts/generate-illustration-preview.tsx. Edit the source artwork, not this file. --><html lang="en" data-theme="website"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Product illustration library — Openship</title><style>${css}</style></head><body>${body}<script>${script}</script></body></html>`,
    { ...formatting, parser: "html" },
  ),
);
console.log(`Wrote ${fileURLToPath(destination)} (${FEATURES.length} illustrations).`);
