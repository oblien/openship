// The native splash embeds CSS as text, so it cannot resolve theme.css's
// relative @import from its offline data URL. Embed the shared palettes directly.
import themeTokens from "../../../dashboard/src/styles/theme-tokens.css";
import regularFont from "../../assets/fonts/Gellix-Regular.woff2";
import mediumFont from "../../assets/fonts/Gellix-Medium.woff2";

const loadingStages = {
  launch: { label: "Launch", message: "Launching Openship" },
  services: { label: "Workspace", message: "Preparing your workspace" },
  dashboard: { label: "Dashboard", message: "Opening your dashboard" },
};

export type LoadingStage = keyof typeof loadingStages;

/** Bundled with main so the first frame needs neither a server nor the network. */
export function buildLoadingScreen(options: {
  dark: boolean;
  version: string;
  windowControls: boolean;
}): string {
  const theme = options.dark ? "dim" : "light";
  const metadata = JSON.stringify({ version: options.version, stages: loadingStages }).replace(/</g, "\\u003c");
  const steps = Object.entries(loadingStages).map(([name, stage], index) =>
    `<li class="step${index === 0 ? " current" : ""}" data-step="${name}"${index === 0 ? ' aria-current="step"' : ""}><div class="step-track" aria-hidden="true"></div>${stage.label}</li>`,
  ).join("");

  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-stage="launch">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:">
  <title>Starting Openship</title>
  <style>${themeTokens}</style>
  <style>
    @font-face{font-family:Gellix;src:url("${regularFont}") format("woff2");font-weight:400;font-display:swap}
    @font-face{font-family:Gellix;src:url("${mediumFont}") format("woff2");font-weight:500;font-display:swap}
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%;background:var(--th-bg-page);color:var(--th-text-title)}
    body{height:100vh;display:grid;grid-template-rows:44px 1fr 64px;overflow:hidden;
      font-family:Gellix,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;user-select:none}
    [data-theme="light"]{color-scheme:light}
    [data-theme="dim"],[data-theme="dark"]{color-scheme:dark}
    .titlebar{display:flex;align-items:center;justify-content:flex-end;padding:0 10px;-webkit-app-region:drag}
    .window-controls{display:flex;gap:4px;-webkit-app-region:no-drag}
    .window-button{display:grid;place-items:center;width:36px;height:30px;border:0;border-radius:7px;
      background:transparent;color:var(--th-text-secondary);cursor:default}
    .window-button:hover{background:var(--th-bg-hover);color:var(--th-text-title)}
    .window-button:focus-visible{outline:2px solid var(--th-text-muted);outline-offset:2px}
    .window-button.close:hover{background:var(--st-danger-bg);color:var(--st-danger-fg)}
    .window-button svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.2}
    .restore{display:none}
    [data-maximized="true"] .maximize{display:none}
    [data-maximized="true"] .restore{display:block}
    main{display:grid;place-items:center;min-height:0;padding:32px 48px}
    .startup{display:grid;grid-template-columns:minmax(0,300px) minmax(0,400px);align-items:center;
      gap:64px;width:min(100%,764px);animation:enter .55s ease-out both}
    .brand{display:flex;align-items:center;gap:13px;margin-bottom:18px}
    .brand-mark{width:28px;height:28px;border:3px solid currentColor;border-radius:50%;flex-shrink:0}
    h1{font-size:36px;line-height:1.15;font-weight:500;letter-spacing:-1.1px;margin:0}
    .intro{margin:0;color:var(--th-text-secondary);font-size:17px;line-height:1.55;max-width:260px}
    .loading{margin-top:38px}
    .status{display:flex;align-items:center;gap:10px;min-height:22px;color:var(--th-text-body);font-size:14px;line-height:1.5}
    .spinner{width:15px;height:15px;flex-shrink:0;border:1.5px solid var(--th-spinner-track);
      border-top-color:var(--th-spinner-fill);border-right-color:var(--th-spinner-fill);border-radius:50%;animation:spin 1s linear infinite}
    .steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;list-style:none;padding:0;margin:20px 0 0}
    .step{font-size:13px;line-height:1.5;color:var(--th-text-hint);transition:color .2s}
    .step.current{color:var(--th-text-title)}
    .step.complete{color:var(--th-text-muted)}
    .step-track{height:3px;border-radius:3px;overflow:hidden;position:relative;background:var(--th-on-08);margin-bottom:9px}
    .step-track::after{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--th-text-title);transform:translateX(-105%)}
    .current .step-track::after{animation:progress 1.8s ease-in-out infinite}
    .complete .step-track::after{background:var(--th-on-30);transform:none}
    .art{width:100%;max-width:400px;justify-self:center}
    .art svg{display:block;width:100%;height:auto;overflow:visible}
    .art .outline{stroke:var(--th-bd-default);stroke-width:1}
    .art .back{fill:var(--th-sf-03);stroke:var(--th-on-06);stroke-width:1}
    .art .middle{fill:var(--th-bg-page);stroke:var(--th-on-10);stroke-width:1}
    .art .surface{fill:var(--th-card-on-page)}
    .art .inset{fill:var(--th-sf-03)}
    .art .soft{fill:var(--th-on-06)}
    .art .muted{fill:var(--th-on-12)}
    .art .strong{fill:var(--th-on-25)}
    .art .brand-ring{stroke:var(--th-text-title);stroke-width:5;fill:none}
    .art .connector{stroke:var(--th-on-10);stroke-width:1.25;fill:none;stroke-linecap:round}
    .art .accent{fill:var(--st-info-bg)}
    .art .accent-line{stroke:var(--st-info-fg);stroke-width:1.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
    .art .activity{transform-box:fill-box;transform-origin:left;animation:activity 2.8s ease-in-out infinite}
    footer{display:flex;justify-content:center;align-items:center;gap:8px;color:var(--th-text-hint);font-size:13px;line-height:1.5;padding:0 24px 12px}
    .footer-separator{width:3px;height:3px;border-radius:50%;background:var(--th-on-20)}
    @keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes progress{0%{transform:translateX(-105%)}100%{transform:translateX(105%)}}
    @keyframes activity{0%,100%{transform:scaleX(.55);opacity:.6}50%{transform:scaleX(1);opacity:1}}
    @media(max-width:900px){.startup{gap:32px;grid-template-columns:minmax(0,280px) minmax(0,340px);width:min(100%,652px)}}
    @media(max-width:660px){body{grid-template-rows:44px 1fr 50px}main{padding:12px 28px}.startup{grid-template-columns:1fr;gap:12px;width:300px}.art{grid-row:1;width:240px}.copy{text-align:center}.brand{justify-content:center}h1{font-size:30px}.intro{max-width:none;font-size:16px}.loading{margin-top:24px}.status{justify-content:center}.steps{text-align:left}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.current .step-track::after{transform:scaleX(.5);transform-origin:left}}
  </style>
</head>
<body>
  <header class="titlebar" aria-label="Window title bar">
    ${options.windowControls ? `<div class="window-controls">
      <button class="window-button" id="minimize" type="button" aria-label="Minimize"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10"/></svg></button>
      <button class="window-button" id="maximize" type="button" aria-label="Maximize"><svg class="maximize" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx=".5"/></svg><svg class="restore" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2V1h7v7h-1"/><rect x="1" y="4" width="7" height="7" rx=".5"/></svg></button>
      <button class="window-button close" id="close" type="button" aria-label="Close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8m0-8-8 8"/></svg></button>
    </div>` : ""}
  </header>
  <main>
    <section class="startup" aria-labelledby="title">
      <div class="copy">
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span><h1 id="title">Openship</h1></div>
        <p class="intro">Deploy anything.<br>Own everything.</p>
        <div class="loading">
          <div class="status" role="status" aria-live="polite" aria-atomic="true"><span class="spinner" aria-hidden="true"></span><span id="stage">${loadingStages.launch.message}</span></div>
          <ol class="steps" aria-label="Startup progress">${steps}</ol>
        </div>
      </div>
      <div class="art" aria-hidden="true">
        <svg viewBox="0 0 400 330" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs><clipPath id="workspace"><rect x="54" y="79" width="284" height="194" rx="18"/></clipPath></defs>
          <rect class="back" x="99" y="39" width="260" height="194" rx="18"/>
          <path class="connector" d="M119 58h32m8 0h9"/>
          <rect class="middle" x="77" y="59" width="272" height="194" rx="18"/>
          <rect class="surface outline" x="54" y="79" width="284" height="194" rx="18"/>
          <g clip-path="url(#workspace)">
            <path class="inset" d="M54 79h284v37H54z"/>
            <rect class="muted" x="70" y="95" width="7" height="7" rx="3.5"/>
            <rect class="soft" x="83" y="95" width="7" height="7" rx="3.5"/>
            <rect class="soft" x="96" y="95" width="7" height="7" rx="3.5"/>
            <rect class="soft" x="266" y="95" width="54" height="6" rx="3"/>
            <path class="inset" d="M54 116h44v157H54z"/>
            <rect class="strong" x="70" y="135" width="12" height="12" rx="4"/>
            <rect class="soft" x="70" y="160" width="12" height="12" rx="4"/>
            <rect class="soft" x="70" y="185" width="12" height="12" rx="4"/>
            <rect class="soft" x="70" y="237" width="12" height="12" rx="6"/>
            <rect class="inset" x="114" y="133" width="206" height="84" rx="12"/>
            <circle class="brand-ring" cx="157" cy="175" r="19"/>
            <rect class="strong" x="193" y="162" width="75" height="6" rx="3"/>
            <rect class="muted" x="193" y="178" width="106" height="4" rx="2"/>
            <rect class="soft" x="193" y="189" width="81" height="4" rx="2"/>
            <rect class="soft" x="114" y="231" width="61" height="25" rx="7"/>
            <rect class="soft" x="186" y="231" width="61" height="25" rx="7"/>
            <rect class="soft" x="258" y="231" width="62" height="25" rx="7"/>
          </g>
          <rect class="surface outline" x="23" y="227" width="148" height="65" rx="14"/>
          <rect class="inset" x="37" y="242" width="34" height="34" rx="9"/>
          <path class="connector" d="M46 252h16m-16 6h16m-16 6h10"/>
          <rect class="strong" x="84" y="246" width="66" height="5" rx="2.5"/>
          <rect class="soft" x="84" y="261" width="72" height="4" rx="2"/>
          <rect class="muted activity" x="84" y="261" width="58" height="4" rx="2"/>
          <rect class="surface outline" x="287" y="48" width="68" height="57" rx="14"/>
          <rect class="accent" x="300" y="61" width="42" height="31" rx="8"/>
          <path class="accent-line" d="m311 77 6 6 14-15"/>
          <path class="connector" d="M367 152v6m0 8v6m-10-10h6m8 0h6M43 155v6m0 8v6m-10-10h6m8 0h6"/>
          <circle class="soft" cx="215" cy="298" r="3"/>
          <circle class="muted" cx="374" cy="229" r="2"/>
        </svg>
      </div>
    </section>
  </main>
  <footer><span>Openship Desktop</span><span class="footer-separator" aria-hidden="true"></span><span id="version"></span></footer>
  <script>
    (function () {
      var metadata = ${metadata};
      document.getElementById("version").textContent = "v" + metadata.version;
      var root = document.documentElement;
      var appearance = window.matchMedia("(prefers-color-scheme: dark)");
      appearance.addEventListener("change", function (event) { root.dataset.theme = event.matches ? "dim" : "light"; });
      var stages = metadata.stages;
      var names = Object.keys(stages);
      window.__osStage = function (stage) {
        var current = names.indexOf(stage);
        if (current < 0) return;
        root.dataset.stage = stage;
        document.getElementById("stage").textContent = stages[stage].message;
        document.querySelectorAll("[data-step]").forEach(function (element, index) {
          element.classList.toggle("complete", index < current);
          element.classList.toggle("current", index === current);
          if (index === current) element.setAttribute("aria-current", "step");
          else element.removeAttribute("aria-current");
        });
      };
      var controls = window.desktop && window.desktop.window;
      if (controls) {
        var minimize = document.getElementById("minimize");
        var maximize = document.getElementById("maximize");
        var close = document.getElementById("close");
        if (minimize) minimize.onclick = function () { controls.minimize(); };
        if (maximize) maximize.onclick = function () { controls.toggleMaximize(); };
        if (close) close.onclick = function () { controls.close(); };
        function syncMaximized(value) {
          root.dataset.maximized = String(value);
          if (maximize) maximize.setAttribute("aria-label", value ? "Restore" : "Maximize");
        }
        controls.isMaximized().then(syncMaximized).catch(function () {});
        var unsubscribe = controls.onMaximizedChange(syncMaximized);
        window.addEventListener("pagehide", unsubscribe, { once: true });
      }
    })();
  </script>
</body>
</html>`;
}
