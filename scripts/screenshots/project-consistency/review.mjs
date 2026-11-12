import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
const output = "artifacts/project-consistency";
await mkdir(output, { recursive: true });
await cp(
  "artifacts/project-environment/before-apps-services.png",
  `${output}/before-apps-services.png`,
);
await cp(
  "artifacts/project-environment/before-settings-editor.png",
  `${output}/before-settings-editor.png`,
);
const figure = (title, file) =>
  `<figure><figcaption>${title}</figcaption><a href="${file}"><img src="${file}" alt="${title}" loading="lazy"></a></figure>`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apps & Services — consistency review</title><style>
*{box-sizing:border-box}body{margin:0;background:#101010;color:#eee;font:15px/1.55 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:36px 24px}h1{font-size:28px;letter-spacing:-.6px;margin:0 0 8px}h2{font-size:21px;margin:40px 0 12px}p{color:#aaa;max-width:900px}a{color:#c7eb96}nav{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 28px}figure{margin:0;min-width:0;background:#181818;border-radius:16px;overflow:hidden}figcaption{padding:14px 18px;color:#ccc;font-size:14px}img{display:block;width:100%;height:auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.phone{max-width:390px;margin:auto}.notes{padding:16px 20px;background:#1b2216;border-radius:12px;color:#d3e6be}.wide{margin-top:18px}#grow+.grid img,#before-after+.grid img{aspect-ratio:16/6;object-fit:cover;object-position:top}@media(max-width:760px){.grid{grid-template-columns:1fr}main{padding:24px 14px}}
</style><main><h1>One Apps & Services flow</h1><p>The app is the first row. Adding PostgreSQL adds another row. The app keeps its URL, saved environment, and detail layout.</p><nav><a href="http://127.0.0.1:3012/projects/environment-preview/services">Open interactive preview ↗</a><a href="#before-after">Before / after</a><a href="#grow">Add a service</a><a href="#edit">Environment</a><a href="#mobile">Mobile / Arabic</a></nav><p class="notes">Actual dashboard components with sample data. Saving and applying affect only the preview fixture. Existing service overrides keep their ownership.</p>
<h2 id="before-after">The starting project</h2><div class="grid">${figure("Before · separate application card", "before-apps-services.png")}${figure("After · the app is the first list entry", "after-single-app.png")}</div>
<h2 id="grow">When PostgreSQL is added</h2><div class="grid">${figure("One app", "after-single-app.png")}${figure("The same app + PostgreSQL", "after-with-postgres.png")}</div><p>The real Add form was exercised in the browser check. The preview’s Add PostgreSQL shortcut opens the resulting state immediately.</p>
<div class="grid">${figure("App overview · shared header and tabs", "after-app-overview.png")}${figure("Add PostgreSQL · existing service form", "after-add-postgres-form.png")}</div>
<h2 id="edit">The same environment editor</h2><div class="grid">${figure("website · project-owned values", "after-app-with-postgres.png")}${figure("postgres · service-owned values", "after-postgres-environment.png")}</div><p>Save stores values. Apply starts a runtime update. Rebuild applies build-time changes. Each panel retains the actions supported by its runtime.</p>
<div class="grid wide">${figure("Before · environment in project Settings", "before-settings-editor.png")}${figure("After · project Settings identifies shared inputs", "after-project-settings.png")}</div>
<h2>Themes</h2><div class="grid">${figure("Light", "after-app-light.png")}${figure("Dim", "after-app-dim.png")}</div>
<h2 id="mobile">Mobile and Arabic</h2><div class="grid"><div class="phone">${figure("Mobile · 390px", "after-mobile.png")}</div><div class="phone">${figure("Arabic · right to left", "after-arabic-mobile.png")}</div></div>
<p>Checks: stable application route through add/remove; existing overrides preserved; separate Save/Apply; untouched secrets retained; draft retained across tabs; theme and overflow checks. <a href="browser-checks.json">Browser verification details</a>.</p></main></html>`;
await writeFile(`${output}/index.html`, html);
console.log(`${output}/index.html`);
