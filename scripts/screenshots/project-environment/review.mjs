import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = process.env.SCREENSHOT_OUTPUT ?? resolve("artifacts/project-environment");
const shot = (file, label) => `<figure><a href="${file}"><img src="${file}" alt="${label}" loading="lazy"></a><figcaption>${label} · <a href="${file}">Open full size</a></figcaption></figure>`;
await writeFile(resolve(output, "index.html"), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Environment management · before and after</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111;color:#e8e8e8}*{box-sizing:border-box}body{max-width:1440px;margin:0 auto;padding:32px 24px 64px}h1{font-size:28px;letter-spacing:-.7px;font-weight:600;margin:12px 0}h2{font-size:20px;margin:36px 0 16px}p,figcaption{color:#aaa;line-height:1.6}a{color:inherit}nav{display:flex;flex-wrap:wrap;gap:20px;margin:24px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;min-width:0}img{width:100%;height:auto;display:block;border-radius:14px;border:1px solid #292929}figcaption{font-size:13px;padding:10px 0}.single{max-width:1100px}.mobile{max-width:390px}section{scroll-margin-top:24px}.variants{display:flex;flex-wrap:wrap;align-items:flex-start;gap:24px}@media(max-width:760px){.pair{grid-template-columns:1fr}body{padding:24px 14px}h1{font-size:24px}}
</style>
<header><p>Openship · UI review</p><h1>Environment management, before and after</h1>
<p>Actual dashboard components rendered with intercepted sample API data. Both baseline and updated captures use the same project and viewport. No live deployment was changed.</p>
<nav><a href="#entry">App entry</a><a href="#settings">Settings editor</a><a href="#application">Application panel</a><a href="#mobile">Mobile and RTL</a><a href="after-browser-checks.json">Browser checks</a></nav></header>
<section id="entry"><h2>Apps & Services</h2><div class="pair">${shot("before-apps-services.png","Before · app card")}${shot("after-apps-services.png","After · Environment shortcut")}</div></section>
<section id="settings"><h2>Settings editor</h2><div class="pair">${shot("before-settings-editor.png","Before · separate environment form")}${shot("after-settings-editor.png","After · shared environment panel")}</div></section>
<section id="application"><h2>Single-app environment panel</h2><p>Save, reload, Apply & restart, and Rebuild & redeploy stay together. Settings opens this same panel.</p><div class="single">${shot("after-application-dim.png","Application environment · dim")}</div><p><a href="after-application-environment.png">Dark theme</a> · <a href="after-application-light.png">Light theme</a> · <a href="after-application-apply.png">Apply progress</a> · <a href="after-apps-services-docker.png">Docker app with roles</a></p></section>
<section id="mobile"><h2>Mobile and Arabic</h2><div class="variants"><div class="mobile">${shot("after-application-mobile.png","Mobile · 390px")}</div><div class="mobile">${shot("after-application-arabic-mobile.png","Arabic RTL · 390px")}</div></div></section>
</html>`);
console.log(`Review gallery: ${resolve(output, "index.html")}`);
