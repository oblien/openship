# Homepage deployment walkthrough

The homepage's `HowItWorks` component pairs five deployment steps with product
screenshots: Connect, Build, Ship, Route and Operate. Keep step copy, screenshot
light and dark screenshot paths, accessible descriptions and guide links together in its
`STEPS` array. A thin vertical rail connects the numbered steps. Its segments use
the same grid rows as the copy, so the line stays connected as text wraps without
JavaScript measurements.

Each left-hand step uses `FeatureIllustration` from `@repo/ui/illustrations`
beside its sentence-case label. Keep the illustration name with the step data:
Git authentication, actions, deployment destinations, domains and monitoring.
Reuse the shared marketing palette and size the art at 70 × 56 px on desktop,
54 × 44 px on phones. The numbered rail remains separate from the artwork and
aligns with the center of that introductory row.

On desktop, the left column scrolls normally and the right screenshot stays
sticky. Steps use a compact, bounded viewport-relative height with room at the
start and end for the larger preview. An `IntersectionObserver` selects the step
nearest the viewport center;
there is no scroll hijacking or animation loop. The dots also navigate to each
step and support keyboard activation. Reduced-motion preferences disable the
card transition and smooth scrolling. Each step pairs a prominent light-theme
screen with a related, rotated dim-theme screen behind it, following the layered
showcase below the hero. Keep the main screen level and readable, the companion
decorative (`aria-hidden` and empty alt text), and both inside the column. Use the
same `WalkthroughScreens` composition for sticky and inline previews.

The composition has two fixed cards. The dark background card, its image and its
8° angle stay unchanged throughout the walkthrough. The front is a permanent,
opaque white surface: only its light screenshots crossfade, over 160 ms. Keep
both cards still. Do not animate rotation, translation, scale or stacking order.

Decode the requested light capture before showing it, then crossfade inside the
white card using the existing Motion `AnimatePresence`. Fading image layers share
one grid cell and are removed after their exit; the card itself never fades, so
the dark background cannot show through. Its accessible label describes only the
current screenshot. Ignore superseded image requests and keep the last complete
screenshot if the next image cannot load. Reduced motion switches images instantly
and disables smooth scrolling.

At widths below 901 px or heights below 650 px, each screenshot appears beneath
its explanation. Keep the media query in `how-it-works.tsx` and `landing.css` in
sync. The desktop image width is also capped by the available viewport height.
Use the existing `site-container` width and theme variables for the surrounding
layout.

## Updating the screenshots

The JPEGs in `apps/web/public/walkthrough` are browser captures of existing
dashboard components, composed with synthetic project, repository, log, domain
and monitoring data. The repository picker includes a personal account and two
organizations with original inline SVG avatars; it needs no external avatar
service. They illustrate product behavior; the sample deployment is
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
`finally`, including on failure. It uses an isolated browser context per theme with
sample data, intercepts API requests, and rejects unexpected mutation attempts. No
authenticated user session or live API data is needed. Do not commit the temporary
route or ship the fixture in the dashboard.

The five views are captured in both light and dim themes using the same 900 × 675
viewport at 2× resolution, fixed clock and reduced motion. Files ending in
`-light.jpg` supply the white card faces; the original filenames supply their dim
counterparts. Capture the actual dashboard theme instead of filtering or inverting
an image. The capture checks the applied theme, browser errors and clipped content
before writing each image. Static imports give each capture a content hash
so changes invalidate cached images. Next Image supplies responsive, lazy-loaded
versions on the homepage.

After changing the walkthrough, inspect all five steps while scrolling down and
back up, test the dot controls, and check mobile and short desktop viewports.
Also test rapid jumps, reversing mid-transition and small scrolls across a step
boundary: the preview must settle on the latest step with exactly two persistent
cards and one foreground image after the crossfade. Sample the transition to
verify that neither card moves, the front surface remains opaque white, and the
background's image, transform and colour never change.
Confirm that the preview stays within the viewport and releases at the end of
the section, and that the rail starts and ends at its numbered markers. Regenerate
both themes when the depicted dashboard components change.
