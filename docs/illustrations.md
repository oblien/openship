# Product illustrations

This is the approved illustration direction for Openship's website and app:
flat, rounded, layered shapes in the surrounding theme's foreground color, with
small warm accents. The nine homepage drawings establish the visual reference.
The [dashboard design guide](dashboard-design.md) remains the entry point for
app theme, layout and typography conventions.

## Source and adoption

- Approved artwork: [`artwork.tsx`](../packages/ui/src/illustrations/artwork.tsx) and
  [`capabilities.tsx`](../packages/ui/src/illustrations/capabilities.tsx) in `packages/ui/src/illustrations`.
- Shared component: `FeatureIllustration` from `@repo/ui/illustrations`.
- Generated HTML catalog: [`docs/design/illustrations/index.html`](design/illustrations/index.html).
- Original approved section: [`feature-section.html`](design/illustrations/feature-section.html).
- Generator: [`scripts/generate-illustration-preview.tsx`](../scripts/generate-illustration-preview.tsx).

All 45 drawings are shared production artwork. The homepage uses nine; the feature
catalog, detail headings and related-feature links use the same
component with a feature's slug. `Feature.slug` is typed as `FeatureIllustrationName`,
so a feature cannot silently ship without matching artwork. Feature titles and
copy stay in `apps/web/src/lib/features.ts`; do not copy them into the artwork map.

The HTML files belong to technical documentation, outside `apps/web/public`.
They are not product routes or published website assets. Open the generated file
in a browser directly, or serve this documentation directory locally:

```sh
bun scripts/generate-illustration-preview.tsx
open docs/design/illustrations/index.html
# Optional HTTP preview, from the repository root:
python3 -m http.server 3010 --bind 127.0.0.1 --directory docs
# http://localhost:3010/design/illustrations/
```

All features are visible together. Search, category links, size controls and
light/dim/dark surfaces support review. The generator renders the actual shared
component, validates catalog coverage and assigns unique SVG IDs in a single
React render. Regenerating must reproduce the current artwork, not maintain a
second manually edited SVG collection. Keep the original section snapshot as a
historical composition reference; edit the component source for current artwork.

## Design approach

Start with what the user can do: deploy a stack, connect a domain, restore data,
or assign access. Choose one concrete visual metaphor for that action. One strong
silhouette and a few subordinate marks should communicate it at 54–80 px wide.
Text carries the full explanation; the illustration helps recognition and rhythm.

Build the drawing from a small set of flat primitives: rounded panels, documents,
circles, connection paths and cutouts. Repeat proportions and visual weight across
the family, while giving each capability a distinct composition. Layer positions
suggest relationships in the same plane, never a camera angle or simulated depth.
Use masks for true holes and theme tokens for solid overlapping details.

Artwork follows the surrounding surface. On dark violet, use pale neutral forms
and champagne accents. On light surfaces, use dark ink, translucent gray layers
and a deeper amber detail. This is a palette change, not a CSS `invert()` filter:
mask colors remain black and white, and semantic UI status colors stay unchanged.
Keep the same geometry and hierarchy across themes.

The surrounding UI should stay calm: consistent card padding, readable headings,
short supporting copy and a clear action. Avoid an extra colored tile around each
illustration, oversized artwork rows, duplicated calls to action and excessive
surface nesting. Reuse the page's spacing and component system. The illustration
family complements control icons; it does not replace tiny navigation glyphs.

## Visual rules

| Part         | Treatment                                                                    |
| ------------ | ---------------------------------------------------------------------------- |
| Canvas       | `viewBox="0 0 80 64"`; transparent outside the drawing                       |
| Primary form | Rounded, flat foreground silhouette with clear negative space                |
| Layers       | Offset in the same plane; foreground opacity around 0.1–0.55                 |
| Accent       | Small warm highlight on one meaningful detail; never a category-wide recolor |
| Corners      | Typically 4–10 units; rounded line caps and joins                            |
| Connectors   | 1.5–3 units; subordinate to the filled shapes                                |
| Content      | One recognizable feature concept; simplified UI, documents, nodes or data    |
| Finish       | Flat fills; no extrusion, perspective, material shading, gradients or glow   |

Keep illustrations quiet enough to sit beside product text on the existing
violet/dark surfaces. Avoid standalone rainbow palettes, full-color backgrounds,
photorealistic objects, emoji, and decorative particles. Reuse the established
forms without giving unrelated capabilities identical drawings.

The warm accent is part of the artwork, **not live application status**. Health,
errors, warnings, progress and availability still use the app's semantic status
components and explicit labels.

## Sizing and placement

The approved homepage uses **70 × 56 px** on desktop and **54 × 44 px** on
mobile. Keep the artwork beside its label and supporting text; it should not
create an empty row on mobile. Maintain consistent optical size and spacing
across a group of features.

Use this family for feature cards, onboarding, explanatory surfaces and
empty-state artwork. Navigation, toolbar buttons, form controls and other
16–24 px action glyphs continue to use [`@repo/ui/icons`](client-icons.md).
Provider logos and user artwork retain their own content sources.

## Public-page layout

The public feature catalog and detail pages share the homepage's `site-container`
and `th-*` theme tokens. Keep the introduction compact and left aligned. Category
links are anchors into a complete visible list; they must not hide features in tabs.

On desktop, put each category's heading and short explanation beside two columns
of illustrated links. Collapse the heading above the list on tablets and use one
column on phones. `IllustratedLink` owns the shared layout for catalog and related
features, migration guides, and help links: artwork, title, short description and
a quiet arrow. `FeatureLink` supplies feature metadata to that component. Use a subtle hover
fill and visible keyboard focus, with no outlined tile, decorative shadow or lift.
Keep dividers at section boundaries instead of around every feature.

Detail pages reuse the illustration beside the title, then show readable prose
and a plain capability list. Do not box each paragraph or capability. Show a product
screenshot only when it actually depicts the feature; otherwise use the text layout.
Use the shared `MarketingCta` once at the end, with the existing Cloud-plan destination
and self-host quickstart. Keep the illustrations small and avoid adding another
large promotional hero above the useful content.

The shared public-page components live in
[`apps/web/src/components/marketing`](../apps/web/src/components/marketing):

- `MarketingIntro` sets the same two-column introduction, heading scale and page inset.
- `MarketingSection` pairs a short section heading with its content. Use section
  dividers, not a border around every item.
- `IllustratedLink` uses the production SVG family. Titles, descriptions and links
  remain page data; do not fork the artwork for another route.
- `MarketingCta` provides the Cloud and self-host actions when the page needs them.
  A page with its own destination choices, such as Migrate, does not need another CTA.
- `ContactPage` shares the support/contact layout and existing request form. On
  phones the form appears first, with alternative contact links below it.

`marketing.css` is imported once by the marketing route layout. Route styles own
only their specific content, such as the app directory's filters or migration FAQ.
Features, Migrate, Apps, About, Trust, Contact and Support use this shared foundation.
Keep their container width at `site-container`; do not add route-specific maximum
widths to imitate the layout.

The download page keeps its seafoam hero, then presents all desktop downloads
together and the CLI beneath them. Use the shared platform detection and
`PlatformIcon` for operating-system marks, `InstallTabs` for the same commands as
the documentation, and the illustration family for explanatory sections. Display
release metadata only when available; do not invent sizes or installation output.

For the homepage's scrolling product walkthrough, see
[deployment walkthrough](design/deploy-walkthrough.md) for layout behavior and
instructions to regenerate its screenshots from actual dashboard components.

The homepage mail section and `/mail` share `MailPreview`: the mail client in front
of a lightly angled, localized administration capture, inside a soft violet frame.
Keep the client dominant and the admin header visible behind it. Regenerate admin captures with
the [mail capture script](../scripts/screenshots/mail/README.md). Keep mail features
in `apps/web/src/lib/mail-features.ts`; use the shared illustrations beside them.
The product page distinguishes Desktop/self-hosted mail administration from Cloud
webmail connected to an existing provider. Keep the layers still and avoid simulated
live counters or animated card swapping.

The homepage comparison uses the same two-tone heading and small shared artwork
beside each group. Keep rows open, with only light separators and a soft OpenShip
column highlight. On phones, each row shows all three providers with explicit labels;
retain the table's accessible row and column relationships.

The app directory uses `MarketplaceAppLink` for both search results and related apps.
It reuses the open row layout but keeps each provider's original logo, catalog
availability and hosting requirements. Categories wrap on phones so none require
discovering a horizontal scroll. Search and category selection continue to use the
existing URL state and catalog filtering. App articles and installation metadata
stay in the existing catalog pipeline.

Homepage app cards use a soft neutral fill, with the original logo beside the
name, a short description and a quiet category-and-arrow footer. Keep names
readable in both text directions and stack cards on phones. Use a subtle hover
fill and visible keyboard focus rather than outlines, shadows or lifting cards.

Migrate is organized around starting points, a move checklist, destination choices,
and practical questions. Keep Cloud copy about shared plan capacity and projects,
and read prices from the live pricing catalog. Do not promise a fixed migration
duration or zero downtime for data transfers. Existing campaign hashes remain
native anchors on visible content rather than selecting a hidden panel.
Provider migration labels use sentence case and normal letter spacing, with the
original provider logo and a slightly stronger provider name. Avoid all-caps badge styling.

## Component and theme integration

```tsx
import { FeatureIllustration } from "@repo/ui/illustrations";

<FeatureIllustration name="compose-multi-service" className="product-illustration" />;
```

The foreground is `currentColor`. Set surface-dependent variables at the
shared theme or surface boundary, rather than copying colors into each drawing:

```css
.product-illustration {
  width: 70px;
  height: 56px;
  color: var(--th-text-title);
  --illustration-cutout: var(--th-card-bg-solid);
  --illustration-surface: var(--th-card-bg-solid);
}
```

| Variable                    | Default   | Purpose                                               |
| --------------------------- | --------- | ----------------------------------------------------- |
| `color`                     | Inherits  | Primary forms and translucent layers                  |
| `--illustration-accent`     | `#ffe2ab` | Small warm accent                                     |
| `--illustration-accent-ink` | `#29212b` | Detail drawn on the accent                            |
| `--illustration-cutout`     | `#15151c` | Solid cutout details where an SVG mask is unnecessary |
| `--illustration-surface`    | `#17161d` | Surface behind an overlapping detail                  |

The approved homepage keeps foreground `#f1f0f5` and the default dark-surface
tokens. The light feature catalog uses `color: var(--th-text-strong)`, accent `#a96c21`,
white accent ink, and the actual card color for both cutout and surface variables.
The preview also shows theme-adapted light and dim samples. Check any
new app placement on its actual background, including hover and disabled states.

The dashboard binds `[data-illustration]` in its shared `theme.css` to
`--th-text-title`, `--th-btn-accent-from`, `--th-btn-accent-text` and
`--th-card-on-page`. Its small accent follows the selected app appearance instead
of the website's fixed champagne/amber accent. Built-in light, dim and dark modes,
personal themes, and the appearance editor all use those same tokens. The optional
`illustration-color` class gives dashboard billing, onboarding and empty-state artwork
neutral light-mode layers: title ink at 55% with transparency, plus the existing
small accent details. The main silhouette must not take its color from either
appearance accent; color belongs to details such as the clock badge or chart dot.
The home welcome opts into `illustration-soft`, mixing title ink
at 45% with transparency in light mode. Unmarked artwork keeps its original ink,
and both treatments retain the existing dim/dark palette. Their color variables
are set at each theme boundary so personal themes and nested appearance previews
resolve against their own tokens. SVG masks are unchanged. Do not add
theme hooks, inline palettes or separate artwork variants to consumers. Plan
headers use 56–64 px artwork; onboarding and empty states use 80 px. Keep actual
payment and runtime status in their existing labeled status components.

Empty-state placements reuse existing subjects: Jobs uses `jobs-triggers`, Backups
uses `backups-restore`, Servers and Clusters use `server-management`, and Private networks uses
`private-networking`. The disconnected Openship Cloud card uses `deploy-anywhere`
at the same 80 px size. Connections keeps the standard Settings key icon in its header
and the original provider logos in its rows. Replace the old oversized panel drawings rather than keeping
a second illustration implementation beside the shared catalog. Filters and compact
inline messages can continue to use utility icons or text alone.

The AI Agents empty-state card uses `ai-mcp` above its centered heading. Its local example
preview uses `push-to-deploy`, `logs-monitoring` and `jobs-triggers` at 80 px,
with `illustration-color` across all themes. Keep the surrounding request, actions
and outcome readable in the welcome column; the artwork does not simulate live status.
Native provider marks stay in the separate setup card, with their original shapes
and colors, rather than using feature illustrations to identify providers.

The component is decorative by default (`aria-hidden`). Supply `title` or an
accessible label only when the drawing conveys information not already present
in adjacent text. Native SVG props, classes and styles are forwarded. The
shared frame assigns unique mask and title IDs with React `useId`, so repeating
an illustration on the same page is safe.

Artwork is bundled JSX: no network asset host, dynamic SVG parsing or HTML
injection. It has no loading state, animation or image request. Import the
dedicated `@repo/ui/illustrations` entry point; do not add another provider or
copy its SVG into a page component.

## Generating another illustration

1. Find the closest existing capability and reuse its primitive shapes and palette.
   Write down one action to communicate and choose a distinct silhouette.
2. Work in the shared artwork source. Use the `IllustrationArtwork` callback's
   instance ID for every mask or clip path. Keep the `80 × 64` view box and use
   `INK`, `ACCENT`, `ACCENT_INK`, `CUTOUT` and `SURFACE` from `palette.ts`.
   Extend the existing shape helpers when a form repeats; do not paste complete
   SVG trees into pages or create raster variants for themes.
3. For a new feature, add its metadata to the existing feature catalog and its
   slug to `featureArtwork`. Keep experiments local until reviewed. A revision to
   existing artwork needs no second metadata record or component.
4. Run the generator and inspect every drawing at 44, 56 and 72 px high, on Website,
   Dark, Dim and Light. Judge silhouette, spacing and contrast beside neighboring
   features. Check the actual page as well as the specimen sheet.
5. Run the UI and website type checks. Verify repeated instances have unique IDs,
   masks resolve, no raster image is fetched, adjacent text provides the name,
   and feature links remain keyboard accessible at desktop and mobile sizes.

A useful brief for code-generated additions is:

> Create a flat vector mini illustration for [capability] using Openship's shared
> 80 × 64 canvas, rounded silhouettes, translucent foreground layers and a small
> warm accent. Communicate [one user action]. Match the existing artwork's optical
> weight and negative space. Use theme variables and instance-scoped mask IDs.
> No perspective, extrusion, gradients, material shading or background tile.
> Keep the existing layout and use the shared FeatureIllustration component.

Do not edit generated preview markup as the source. Do not add an image service,
SVG parser, separate light/dark asset files or another illustration renderer.
