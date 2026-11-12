The homepage and `/mail` share a capture of the real `MailAdminPanel`. The fixture
uses fictional `example.com` accounts and does not change production components.
It captures every supported language, including the dashboard's Arabic layout.

Run a dashboard development server on port 3012, then run from the repository root:

```sh
bun scripts/screenshots/mail/capture.mjs
```

Set `SCREENSHOT_ORIGIN` for another local port. If Playwright is installed outside
this workspace, set `PLAYWRIGHT_MODULE` to its module path. `SCREENSHOT_LOCALES=en,ar`
limits captures while reviewing a change; omit it before publishing updated assets.

The script creates and removes a development-only `/mail-capture` route. All browser
API requests are intercepted, including background preference writes; no mailbox,
server, or account is changed. Unexpected API calls, rendering errors, and mismatched
language, theme, or image dimensions fail the capture. A session-presence cookie
only lets the temporary route pass the frontend proxy; it grants no API access.

Outputs are 2400 × 1520 WebP files in
`apps/web/public/screenshots/<locale>/mail-control-panel.webp`. Keep the image's
dimensions in `MailPreview` aligned with the fixture if the capture size changes.
The shared preview layers this admin capture behind the existing mail-client image.
