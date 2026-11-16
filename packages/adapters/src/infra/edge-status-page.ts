/** Built-in visitor pages share one neutral theme. Static, trusted copy only:
 * this result is a single nginx return token, not a user HTML renderer. */
export function edgeStatusPage(options: {
  marker: string;
  title: string;
  label: string;
  description: string;
  detail: string;
}): string {
  return [
    `<!doctype html><!--${options.marker}--><html lang="en"><head>`,
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="robots" content="noindex,nofollow"><title>${options.title}</title>`,
    `<style>:root{color-scheme:dark}*{box-sizing:border-box}`,
    `body{margin:0;min-height:100vh;display:grid;place-items:center;background:rgb(16,16,16);color:rgb(242,242,242);font:16px/1.65 system-ui,sans-serif;-webkit-font-smoothing:antialiased}`,
    `main{width:min(100%,500px);padding:48px 28px}svg{width:100px;height:80px;margin-bottom:24px}`,
    `small{display:block;color:rgb(160,160,160);font-size:13px}h1{font-size:32px;line-height:1.2;letter-spacing:-.035em;font-weight:550;margin:12px 0 20px}`,
    `p{color:rgb(180,180,180);margin:0 0 12px}.detail{color:rgb(160,160,160);font-size:14px}footer{margin-top:36px;color:rgb(150,150,150);font-size:12px}</style></head><body><main>`,
    `<svg viewBox="0 0 100 80" fill="none" aria-hidden="true"><rect x="28" y="20" width="64" height="48" rx="12" fill="rgb(29,29,29)"/><rect x="8" y="8" width="68" height="50" rx="12" fill="rgb(42,42,42)"/><rect x="20" y="22" width="30" height="4" rx="2" fill="rgb(130,130,130)"/><rect x="20" y="34" width="44" height="4" rx="2" fill="rgb(80,80,80)"/><circle cx="72" cy="56" r="16" fill="rgb(235,235,235)"/><path d="M72 48v9m0 6v1" stroke="rgb(24,24,24)" stroke-width="3" stroke-linecap="round"/></svg>`,
    `<small>${options.label}</small><h1>${options.title}</h1><p>${options.description}</p><p class="detail">${options.detail}</p><footer>Served by Openship</footer>`,
    `</main></body></html>`,
  ].join("");
}
