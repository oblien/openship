# Provider logos

## AI Agents

The welcome card reuses the shared Codex and Claude icons. Grok uses the same
[LobeHub SVG](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/grok.svg)
as BytesMap, under the bundled `LICENSE.lobehub` (MIT). Antigravity uses the
[official full-color icon](https://antigravity.google/assets/image/brand/antigravity-icon__full-color.svg)
from Google's [press assets](https://antigravity.google/press), retrieved 2026-11-12.
Both are bundled locally and rendered through `IconArtwork`: Grok follows the
foreground with a mask; Antigravity retains its brand colors. The marks identify
their respective products, not new native runtime integrations. Antigravity links
to the existing MCP setup; Grok uses the existing custom API connection.

## Infrastructure

Railway and Vercel migration connections share the `AppLogo` renderer. Railway uses
the [Devicon v2.16.0 mark](https://github.com/devicons/devicon/blob/v2.16.0/icons/railway/railway-original.svg)
under the MIT license below, with black fill for light surfaces. Vercel uses its
[official black symbol](https://vercel.com/geist/brands/assets/vercel-symbol-black.svg)
from the [brand assets](https://vercel.com/geist/brands). Both monochrome marks invert
on dark and dim surfaces; their shapes are unchanged. Copies are bundled in dashboard
and website assets so they load without a third-party image request.

The shared migration service cards also use PostgreSQL, MySQL and MongoDB marks
from [Devicon v2.16.0](https://github.com/devicons/devicon/tree/v2.16.0/icons),
bundled unchanged in both apps' `public/app-logos` directories under the same MIT
license. These retain their original brand colors.

These SVGs are bundled locally for self-hosted and offline dashboards.
`InfrastructureProviderLogo` renders them through the shared `AppLogo` component;
Custom uses the shared network glyph. Provider names and network types come from
the capabilities catalog.

- Hetzner, DigitalOcean, OVH, Scaleway: [Simple Icons 13.21.0](https://github.com/simple-icons/simple-icons/tree/13.21.0/icons), distributed under [CC0](https://github.com/simple-icons/simple-icons/blob/13.21.0/LICENSE.md). Their official brand colors are applied to the SVG root.
- AWS, Azure, Google Cloud: [Devicon v2.16.0](https://github.com/devicons/devicon/tree/v2.16.0/icons), distributed under the [MIT license](https://github.com/devicons/devicon/blob/v2.16.0/LICENSE).

The marks belong to their respective brands. Network profiles for Hetzner
Dedicated and Hetzner Cloud share the Hetzner mark.
