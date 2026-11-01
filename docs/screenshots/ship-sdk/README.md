# Ship SDK code image

`ship-sdk.png` presents a complete remote deployment example with syntax
highlighting. The source comes directly from the SDK guide's `deploy-app.mts`
example and is checked against the public package declarations before capture.

- `ship-sdk.png`: image for sharing.
- `ship-sdk.html`: standalone artwork with embedded brand fonts.
- `deploy-app.mts`: the exact code shown in the image.

The example requires OpenShip 0.8.0+, an API URL, a token, an organization ID,
an application directory, and a configured deployment target. See the
[SDK guide](https://openship.io/docs/api/sdk) for setup and supported operations.
The capture renders code; it does not execute the deployment.

To regenerate, use the existing Playwright installation and Chromium executable:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
node scripts/screenshots/ship-sdk/capture.mjs
```

The renderer reuses the website's Shiki dependency and brand fonts. It requires
the public SDK declarations (`bun run build:sdk` if they are absent). No preview
route or separate application server is created.
