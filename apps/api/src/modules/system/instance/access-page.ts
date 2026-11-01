import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Hono } from "hono";
import { html } from "hono/html";
import { desktopInstanceLink } from "@repo/core";
import { secureRouter } from "../../../lib/secure-router";
import { requestApiPublicUrl } from "@repo/platform/engine/lib/public-url";

/** API-only instances still have a useful invitation landing page. Desktop
 * renders the existing account/invitation screens; there is no second signup
 * implementation or public admin bootstrap here. */
const r = secureRouter(new Hono(), {
  module: "instance-access",
  basePath: "",
  localOnly: true,
  mcpExcluded: "Browser landing pages for API-only instances.",
});
const reason =
  "Static instructions for an API-only instance; no session, account or invitation data is returned.";
for (const path of ["/", "/login", "/accept-invite/:id"]) {
  r.public("get", path, { reason }, (c) => {
    const id = c.req.param("id");
    if (id && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return c.notFound();
    const origin = requestApiPublicUrl(c.req.raw);
    const address = id ? `${origin}/accept-invite/${encodeURIComponent(id)}` : origin;
    let desktopLink: string | null = null;
    try { desktopLink = desktopInstanceLink(address); } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/modules/system/instance/access-page"); /* Keep manual instructions for an unconfigured HTTPS URL. */ }
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>Open in Openship Desktop</title>
            <style>
              :root {
                color-scheme: light dark;
                font-family: system-ui, sans-serif;
                color: #eee;
                background: #131313;
              }
              * {
                box-sizing: border-box;
              }
              body {
                margin: 0;
                min-height: 100dvh;
                display: grid;
                place-items: center;
                padding: 24px;
              }
              main {
                width: 100%;
                max-width: 480px;
                background: #1d1d1d;
                border-radius: 24px;
                padding: 32px;
              }
              small {
                color: #aaa;
              }
              h1 {
                font-size: 24px;
                letter-spacing: -0.6px;
                margin: 20px 0 12px;
              }
              p {
                color: #aaa;
                line-height: 1.65;
                font-size: 14px;
              }
              label {
                display: block;
                font-size: 13px;
                margin: 24px 0 8px;
              }
              input {
                width: 100%;
                padding: 14px;
                border: 0;
                border-radius: 12px;
                color: inherit;
                background: #131313;
                font: inherit;
                font-size: 13px;
              }
              a {
                display: inline-block;
                margin-top: 20px;
                border-radius: 12px;
                background: #eee;
                color: #161616;
                padding: 12px 18px;
                font-size: 14px;
                text-decoration: none;
                font-weight: 600;
              }
              a.download {
                background: transparent;
                color: inherit;
                padding: 0;
              }
              input:focus-visible,
              a:focus-visible {
                outline: 2px solid #999;
                outline-offset: 3px;
              }
              @media (prefers-color-scheme: light) {
                :root {
                  background: #f8f8f8;
                  color: #171717;
                }
                main {
                  background: white;
                }
                p,
                small {
                  color: #666;
                }
                input {
                  background: #f3f3f3;
                }
                a {
                  background: #171717;
                  color: white;
                }
              }
            </style>
          </head>
          <body>
            <main>
              <small>Openship</small>
              <h1>${id ? "Join your team in Desktop" : "Your instance is online"}</h1>
              <p>
                Open this instance in Desktop, then sign in${id ? " or create your invited account. Review the workspace and role before joining" : " with your account"}.
              </p>
              ${desktopLink ? html`<a href="${desktopLink}" rel="noreferrer">Open in Openship Desktop</a>` : ""}
              <p>
                Desktop didn't open? Copy the address below. In
                <strong>Settings → Instance</strong>, open More instance options and choose
                <strong>Connect to an existing instance</strong>, then paste it.
              </p>
              <label for="address">${id ? "Invitation address" : "Instance address"}</label
              ><input id="address" type="text" readonly value="${address}" /><a
                class="download"
                href="https://openship.io/download"
                rel="noreferrer"
                >Get Openship Desktop</a
              >
            </main>
          </body>
        </html>`,
    );
  });
}
export const instanceAccessPages = r.hono;
