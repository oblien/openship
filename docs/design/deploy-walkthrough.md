# Homepage deployment walkthrough

The homepage's `HowItWorks` component pairs five deployment steps with product
screenshots: Connect, Build, Ship, Route and Operate. Keep step copy, screenshot
paths, accessible descriptions and guide links together in its `STEPS` array.

On desktop, the left column scrolls normally and the right screenshot stays
sticky. An `IntersectionObserver` selects the step nearest the viewport center;
there is no scroll hijacking or animation loop. The dots also navigate to each
step and support keyboard activation. Reduced-motion preferences disable the
image transition and smooth scrolling.

At widths below 901 px or heights below 650 px, each screenshot appears beneath
its explanation. Keep the media query in `how-it-works.tsx` and `landing.css` in
sync. The desktop image width is also capped by the available viewport height.
Use the existing `site-container` width and theme variables for the surrounding
layout.

## Updating the screenshots

The JPEGs in `apps/web/public/walkthrough` are browser captures of existing
dashboard components, composed with synthetic project, repository, log, domain
and monitoring data. They illustrate product behavior; the sample deployment is
not a live workload or a benchmark. Use the real components rather than rebuilding
dashboard controls in the marketing site.

The fixture and capture script live in `scripts/screenshots/deploy-walkthrough`.
To regenerate, start the dashboard development server, then run from the repository
root with Playwright and its Chromium browser available:

```sh
SCREENSHOT_ORIGIN=http://localhost:3002 \
  node scripts/screenshots/deploy-walkthrough/capture.mjs
```

Set `PLAYWRIGHT_MODULE` to an absolute module path if Playwright is installed
outside the repository. Point `SCREENSHOT_ORIGIN` at the local dashboard server.

The script creates an exclusive, temporary development route and removes it in
`finally`, including on failure. It uses an isolated browser context with sample
data, intercepts API requests, and rejects unexpected mutation attempts. No
authenticated user session or live API data is needed. Do not commit the temporary
route or ship the fixture in the dashboard.

All five images use the same 900 × 675 viewport at 2× resolution, dim theme, fixed
clock and reduced motion. The capture checks for browser errors and clipped
content before writing each image. Static imports give each capture a content hash
so changes invalidate cached images. Next Image supplies responsive, lazy-loaded
versions on the homepage.

After changing the walkthrough, inspect all five steps while scrolling down and
back up, test the dot controls, and check mobile and short desktop viewports.
Confirm that the preview stays within the viewport and releases at the end of
the section. Regenerate the images when the depicted dashboard components change.
