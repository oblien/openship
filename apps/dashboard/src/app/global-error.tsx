"use client";

/**
 * Root global-error boundary. Next prerenders `/_global-error` at build time; its
 * DEFAULT page crashes during static export on Next 16 ("useContext" of null).
 * Providing a minimal custom one (own <html>/<body>, no providers or context)
 * avoids that and gives a real last-resort error screen.
 *
 * This one replaces the ROOT layout, so unlike the other dead ends it gets NO
 * globals.css, no theme tokens and no dictionary — everything here is inline and
 * in English by necessity. It still carries the brand mark, honors the OS colour
 * scheme (the app is dark by default; a hardcoded white page was jarring), and
 * links out, so the visual family holds.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <style>{`
          :root { color-scheme: light dark; --bg:#ffffff; --fg:#0f0f0f; --line:rgba(0,0,0,0.14); --soft:rgba(0,0,0,0.05); }
          @media (prefers-color-scheme: dark) {
            :root { --bg:#0b0b0b; --fg:#f5f5f5; --line:rgba(255,255,255,0.16); --soft:rgba(255,255,255,0.06); }
          }
          body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
                 background:var(--bg); color:var(--fg);
                 font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
          .ge-wrap { max-width:420px; text-align:center; }
          .ge-brand { display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:28px; }
          .ge-mark { width:22px; height:22px; border:3px solid var(--fg); border-radius:999px; }
          .ge-name { font-size:15px; font-weight:600; letter-spacing:-0.01em; }
          .ge-title { font-size:22px; font-weight:500; letter-spacing:-0.02em; margin:0 0 8px; }
          .ge-body { font-size:14px; line-height:1.6; opacity:0.65; margin:0 0 24px; }
          .ge-btn { border:1px solid var(--line); background:var(--soft); color:var(--fg); border-radius:12px;
                    padding:10px 20px; font:inherit; font-size:14px; font-weight:500; cursor:pointer; }
          .ge-btn:hover { opacity:0.85; }
          .ge-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; opacity:0.4; margin:24px 0 0; }
          .ge-links { display:flex; align-items:center; justify-content:center; gap:16px; margin-top:24px; font-size:12px; }
          .ge-links a { color:inherit; opacity:0.6; text-decoration:none; }
          .ge-links a:hover { opacity:1; }
          .ge-dot { width:4px; height:4px; border-radius:999px; background:currentColor; opacity:0.25; }
        `}</style>
      </head>
      <body>
        <div className="ge-wrap">
          <div className="ge-brand">
            <div className="ge-mark" aria-hidden="true" />
            <span className="ge-name">Openship</span>
          </div>

          <h1 className="ge-title">Openship couldn&rsquo;t start</h1>
          <p className="ge-body">
            The dashboard failed to load. Your deployments and containers keep
            running — this is only the control panel. Try again, and if it
            persists, restart Openship.
          </p>

          <button type="button" className="ge-btn" onClick={() => reset()}>
            Try again
          </button>

          {error?.digest && <p className="ge-code">Ref {error.digest}</p>}

          <div className="ge-links">
            <a href="https://openship.io/docs" target="_blank" rel="noopener noreferrer">
              Documentation
            </a>
            <span className="ge-dot" aria-hidden="true" />
            <a
              href="https://github.com/oblien/openship/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              Report an issue
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
