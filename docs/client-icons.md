# Client icons

The dashboard, Openship Cloud UI, and desktop chrome use the same icon catalog
from `@repo/ui/icons`. The default theme is `outline-modern`, with 193 bundled
PNGs in `apps/dashboard/public/icons` (about 448 KB total). Source files retain
their original square dimensions.

The dashboard's `ThemeIcon` shares the current-theme symbols across the sidebar,
auth pages, and onboarding: sun for light, sun-and-moon for dim, and moon for dark.

## Use an icon

```tsx
import { Icon, type IconName } from "@repo/ui/icons";

<Icon name="server" className="size-4 text-muted-foreground" />;

// Store IDs in navigation, status, and action metadata.
const actionIcon: IconName = "refresh";
<Icon name={actionIcon} size={16} />;
```

Reuse an existing ID when two controls mean the same thing. Filenames and asset
hosts belong in the catalog and provider, not in individual controls. The catalog
is `packages/ui/src/icons/catalog.ts`; `IconName` is derived from its keys, so
unknown IDs fail type checking. Stale IDs received at runtime display
`help-circle`.

Icons are decorative by default. Give an icon-only button an accessible label on
the button. For an image that conveys information by itself, pass `title`,
`aria-label`, or `aria-labelledby` to the icon.

## Artwork and colors

Each catalog entry has a literal `file` name and a rendering `mode`:

| Mode | Behavior | Suitable artwork |
| --- | --- | --- |
| `mask` | Uses the PNG's alpha channel and inherits `currentColor` | Transparent monochrome glyphs |
| `color` | Preserves the original pixels | Multicolor brand marks or illustrations |

Use existing semantic color classes such as `text-muted-foreground`,
`text-primary`, or `text-danger`. The normal light, dim, and dark appearance themes
all use the same outline catalog and get their colors from those tokens.

Bundled assets also declare their visible alpha `bounds` as `[x, y, width,
height]` in a 24-unit canvas. The renderer centers that artwork in 22 units by
default, leaving a one-unit inset. Transparent padding in a source PNG therefore
does not make its icon smaller than its neighbors. An optional asset `inset`
adjusts the visible size while preserving the control's layout: `arrow-up-right`
uses an inset of 3 to fit its compact artwork in 18 units. Bounds and inset stay
with the artwork through local, CDN, and fallback rendering; the original PNG
files stay identical. Sidebar navigation uses 20px viewports; its collapse and
expand controls use the selected rounded-panel-and-chevron artwork at 16px.
Source variants use complete outlines instead of decorative breaks; gaps in
arrows, spinners, and dashed status symbols convey their normal meaning.

MCP links, settings, and authorization use the shared `mcp` ID and the supplied
`mcp.png` logo. Platform components share `server-settings`, projects use
`project`, and service groups use `layers`. Individual services use `ServiceIcon`
for their brand or role, including the overview summary and migration cards.
Building from source does not change the role icon; a failed brand logo uses the
same role fallback. Unknown applications use `window`.
Redis uses the bundled `redis` mark in `color` mode, preserving its red artwork.
The Valkey app's historical `redis` template ID keeps Valkey's own logo; that
application alias does not apply to Redis image brands.

`IconArtwork` is the single underlying PNG renderer. Its SVG viewport preserves
existing CSS sizing, SVG refs, and placement inside topology diagrams. It does
not draw a separate vector icon. `Icon` resolves catalog IDs through this renderer;
the icon picker also uses it for previews of user-selected artwork URLs.

## Local assets and CDN configuration

The default asset base is `/icons`. Self-hosted and desktop installations serve
the bundled files without contacting an icon CDN.

To use a CDN, mirror `apps/dashboard/public/icons` under the desired prefix and
set this in the dashboard environment before starting it:

```env
OPENSHIP_ICON_BASE_URL=https://cdn.oblien.com/static/png-icons
```

The dashboard root layout passes this server runtime setting to `IconProvider`.
It is not a `NEXT_PUBLIC_` build-time setting. Local and CDN copies use exactly
the same filenames. Keep spaces and literal percent characters in stored names;
the URL resolver encodes each filename once.

If a CDN or custom-theme asset fails to load, the icon falls back to its bundled
default. A failed fallback does not start a retry loop. Changing the source URL
allows the new source to load.

## Alternate artwork themes

An artwork theme can replace some or all catalog entries without changing the
controls that use them:

```tsx
import { Icon, IconProvider, type IconTheme } from "@repo/ui/icons";

const theme: IconTheme = {
  name: "custom",
  icons: {
    server: { file: "custom-server.png", mode: "mask", bounds: [2, 2, 20, 20] },
    google: { file: "custom-google.png", mode: "color" },
  },
};

<IconProvider theme={theme}>
  <Icon name="server" size={20} />
</IconProvider>;
```

Unspecified entries use the default catalog. A nested provider inherits its
parent's base URL or theme when that setting is omitted. Supply the replacement
files at the configured asset base. No theme selection screen is required to use
this API.

For replacement assets, measure the nontransparent pixel bounds and scale each
coordinate from the source canvas to 24 units. Supply those as `bounds` to keep
the same visual sizing. Set `inset` if the glyph needs an optical adjustment;
it must be at least 0 and less than 12. Artwork without bounds uses its full
image canvas and ignores inset, which is useful for arbitrary previews.

When adding an icon, first check the catalog for an equivalent ID. Add only the
selected PNG, with a transparent background for masks, and keep its source
filename. Do not copy the full source library or add another rendering helper.

## Migration audit

| Client area | Coverage |
| --- | --- |
| Navigation and shared controls | Sidebar, tabs, menus, buttons, dialogs, toasts, loading indicators, file icons, and icon picker previews |
| Projects and deployments | Project cards, build pages, Compose services, environment, routes, logs, volumes, backups, and settings |
| Infrastructure | Servers, clusters, migration, monitoring, issues, and topology diagram glyphs |
| Cloud and account | Cloud connection, billing, quotas, onboarding, authentication, GitHub, permissions, and integrations |
| Dashboard mail administration | Setup, domains, mailboxes, health, delivery, backups, and administration |
| Desktop | Navigation, menus, and window control glyphs |

Direct dashboard Lucide imports, the old `utils/icons.js` CDN helper, the unused
icon-font mapping, and the duplicate project-tab icon map were removed. React
Flow controls use catalog glyphs while React Flow continues to own viewport
operations and zoom limits.

Charts, progress geometry, topology edges, decorative illustrations, and the
Openship wordmark remain vectors. Dynamic application/framework/provider logos,
favicons, flags, and user artwork retain their existing content sources. The
separate marketing site and `apps/email/client` are outside this pass.

## Asset provenance

- 176 assets were selected from the supplied `~/Documents/png-icons` library;
  their filenames are preserved for CDN mirroring.
- 9 symbols retain the previous Lucide artwork as bundled outline PNGs where
  the library did not offer a suitable equivalent: `archive`, `bug`,
  `circle-dashed`, `hard-drive`, `infinity`, `memory`, `more`, `pin-off`, and
  `webhook`. The original ISC/MIT notices are in
  `apps/dashboard/public/icons/LICENSE.lucide`.
- 7 marks preserve existing application artwork as PNGs: `google`, `claude`,
  `cursor`, `windsurf`, `zed`, `openai`, and `copilot`. Google's multicolor mark
  uses `color` mode.
- `redis` is the red Redis R from [Simple Icons](https://cdn.simpleicons.org/redis),
  rasterized to a transparent 128px PNG with its original brand color.

There are no duplicate filenames, byte-identical PNGs, or pixel-identical assets
in the default catalog.

## Verification

The migration passed the dashboard TypeScript check, all 193 dashboard test
files (2,052 tests), the shared UI package build, and the production dashboard
build. The lockfile also passed frozen resolution with the release's pinned Bun
1.3.3.

The icon tests cover catalog completeness and duplicate files, ID and filename
resolution, configuration, rendering modes, refs and sizing, accessibility,
hydration, diagram nesting, file classification, and failure recovery. A source
guard catches a return to the old dashboard icon imports or hardcoded icon CDN.

A browser fixture using the actual shared controls and production CSS checked
all local assets and their visible pixels in light, dim, and dark themes,
hydration, sizes from 12 to 32 pixels, visible sidebar sizing against the previous
icons, RTL keyboard navigation, dropdown actions,
React Flow zoom limits and fit-to-view, colorful overrides, and recovery from a
failed CDN request without a retry loop. These checks cover icon rendering and
the affected shared controls; they do not substitute for exercising every
deployment or server operation.
