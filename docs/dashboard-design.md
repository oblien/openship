# Dashboard design

Use this guide for dashboard UI work. The dashboard uses layered surfaces, compact controls,
and a consistent type hierarchy across light, dim, and dark themes.

## Surfaces and controls

Use semantic classes from [theme.css](../apps/dashboard/src/styles/theme.css). The nested-card
rules in [globals.css](../apps/dashboard/src/app/globals.css) supply the theme-specific layering.
Keep palette definitions there instead of introducing page-specific colors.

| Element           | Treatment                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Page              | `bg-background`, using `PageContainer`                                                            |
| Section card      | `rounded-2xl bg-card p-5`, no decorative outline                                                  |
| Nested route card | `rounded-xl bg-card p-4`, no decorative outline                                                   |
| Text input        | Shared `Input` with `variant="filled"`; recessed `bg-background`                                  |
| Form dropdown     | Shared `CustomSelect` with `variant="filled"` and `triggerClassName="bg-muted/60 hover:bg-muted"` |
| Supporting text   | `text-muted-foreground`                                                                           |

Nested `bg-card` surfaces adapt through the shared CSS: light uses a subtle gray fill, while
dim and dark lift the inner surface. Form dropdowns use a lighter surface than text inputs;
the trigger override above is intentional because `filled` alone uses the input background.

Keep visible keyboard focus, error indicators, meaningful selection outlines, and useful dividers.
Borderless cards do not remove those functional indicators. Menus should use the shared dropdown
component's existing positioning, keyboard behavior, and menu surface.

Reuse [Input](../apps/dashboard/src/components/ui/input.tsx),
[CustomSelect](../apps/dashboard/src/components/ui/CustomSelect.tsx), and
[Button](../apps/dashboard/src/components/ui/button.tsx) instead of copying their implementations.

## Layout and density

- Use [PageContainer](../apps/dashboard/src/components/ui/PageContainer.tsx) for its existing
  1600px page limit and responsive padding. Avoid a second page-width cap inside it.
- Project and deployment configuration pages use a 340px action sidebar when there is room,
  then stack on smaller containers. Catalog installs keep their destination and action together.
  Source deployments use the same destination summary above configuration and target-settings
  screen in Cloud and self-hosted mode; do not add a separate destination panel to the sidebar.
- Connected and managed destinations use the same searchable server rows; managed rows show
  project count and purchased capacity in place of an SSH address. Keep the add-server action
  inside the multi-server menu and beside the single-server summary.
- Add Server keeps the connected/managed choice stacked in the right sidebar above setup
  guidance. On narrow screens, place that same choice before the form and guidance after it.
  Reuse the shared acquisition picker in both setup modes and dialogs.
- Destination settings use the normal page layout: server selection first, then visible
  runtime, resource and rollback sections, with a 340px preview/Continue sidebar. Keep the
  same layout in Cloud and self-hosted mode; do not hide it in an Advanced accordion.
- Machine power defaults to the full available server capacity. Project settings and
  deployment setup share the resource editor and tier labels. Optional limits apply to
  containers; the managed server's purchased allocation stays separate.
  In destination settings, offer Full capacity and Customized as peer selection cards;
  Customized keeps the presets visible below. Keep a Back action in the page header.
- Destination, runtime and resource choices share [OptionCard](../apps/dashboard/src/components/shared/OptionCard.tsx),
  including its selected border and radio marker. Do not introduce a separate switch style.
- Base grids on the available container width so expanded navigation does not squeeze fields.
  Routing cards use two columns when their controls fit comfortably and one column otherwise.
- Keep section spacing consistent (`gap-6` between main columns, `space-y-4` for sidebar items).
  Match action sizes within the same flow. The install action is 44px tall; shared buttons retain
  their established sizes (the default `Button` is 40px).
- A destination with one existing server uses a compact summary row; multiple servers use
  the shared picker. Keep the create-server action visible in both cases. Cloud deployments
  can reuse a server's plan or create a separate server and subscription from the same flow.
- Import discovery defaults to Cards, with the shared topology canvas as an optional view.
  Each Compose project has its own section and canvas; do not add another parent node around
  its services. Recovered Openship projects belong in the same selector; their recovery action
  and naming live in the sidebar. Selection uses the shared OptionCard surface and border.
  Discovery cards use two lines: service name with the shared status ring and selection
  control, then the image and volume count. Keep Add project beside the project name and
  show it only after selecting services, while unassigned services remain.
  Expand additional groups on demand. Selection and names survive view and step changes.
  Only draw discovered dependencies; keep scan graphs in memory without saved configuration.
- Import progress and discovery notices stay in the right sidebar. Keep scan settings in the
  shared compact menu beside scan controls. The repository summary uses the same filled card,
  inputs and dropdowns as the other steps, with concise guidance.
- Import routing uses two columns when the container has room, with a compact summary on the
  right. Expanded service controls stay in their column; collapsed neighbors keep their own
  height. Put compact Expand all / Collapse all actions above the service grid. Show detected
  domains and incomplete routes immediately, and reuse the domain, volume and environment
  editors. Routing choices are Custom, Free and Internal only, using the shared routing labels.
  Detected routes appear under Custom and retain their original import behavior until edited.
  Destination and transfer review have a final step for both same-server and cross-server
  imports. The page and modal share the whole preparation layout and controls.
- The Cloud sidebar orders its sections as Main, Settings, then Infrastructure.
  Self-hosted instances keep Infrastructure before Settings, including when connected to Cloud.
- Projects and catalog Apps have separate top-level sidebar entries and lists, backed by the
  same project data and status handling. Apps uses a compact installed list with at most
  three catalog suggestions alongside it, Home's app illustration and a link to the full
  catalog. Its empty state shows connected app logos and popular install shortcuts.
  Keep Home's project list and the sidebar counts separate too.
- Persistent Cloud credit warnings use a compact floating disclosure at the bottom end of the
  viewport. Keep server-specific billing actions inside it, remember dismissal for the warning,
  and allow reopening without a page-wide banner or an automatic modal.
- Plan comparisons lead with CPU, memory, storage and service/project limits. Keep build
  time separate from runtime capacity; show minutes only when the offer defines a time
  allowance. Put metering and shared-capacity explanations once below the plans. Keep
  benefits visible, and use catalog feature keys to avoid repeating resource facts.
- Cloud billing keeps its header and tabs mounted when switching servers. List managed
  servers in the right sidebar with Add server, reusing the shared destination rows.
  One server is a summary; several servers switch billing directly from the visible list.
  Keep the selected server's plan below that list, including beside plan comparisons.
  Unscoped billing opens an existing subscription directly; never
  auto-switch a checkout return or an explicitly selected server. New customers see only
  Plans and pricing, without empty usage, payment or invoice tabs. Keep the full navigation
  for existing subscriptions, allocated servers and credit history, including stopped or
  canceled servers. Show current plan, renewal date or inactive subscription state for
  existing servers; never replace those with a first-purchase promotion.
  In-app credit alerts
  link directly to the scoped billing tab; only a genuine organization change needs
  authorization and a context reload.
- Custom resources sit beside the preset plan choice. Keep CPU, RAM and disk controls
  with a compact monthly total, wait for a matching server quote before enabling
  checkout, and expose bundle pricing details on demand. Applying a paid resource
  change reuses the server's affected-project review and restart confirmation.
- Plan cards respond to their container: one column on phones, two at intermediate widths,
  and four when readable. Offer links to each plan above a stacked comparison; never rely
  on hidden horizontal overflow to reveal additional plans.
- Deployment plan dialogs use compact title and action rows. Keep explanations in the
  scrollable content so the plans receive most of the available viewport height, including
  on short screens. Keep actions side by side on phones, allowing long labels to wrap.
- The plans comparison (`/billing/plans`) and Scale canvas open with the desktop sidebar
  collapsed. Keep the toggle available, restore the normal preference on leaving, and
  keep manual expansion independent between these sections. Mobile navigation opens fully.

## Typography and copy

Use the existing Gellix / SF Arabic font stack and semantic text colors. `text-sm` is 14px;
the dashboard overrides `text-xs` to **13px**, with a 20px line height.
Use `text-sm` for field labels, controls, and primary list information; use `text-xs` for hints
and supporting metadata. Match nearby page headings instead of introducing a new size scale.

Use **Domains & routing** for sections covering domains, published ports, and internal access. Use
**Domains** when the section only manages hostnames. Put shared UI copy in the locale dictionaries.
Keep hints concise and explain choices where they help the user decide.

Catalog category filters match the Library's tabs: compact `text-sm` labels with `px-4 py-2`,
`rounded-lg`, and a filled `bg-foreground text-background` selected state. Inactive choices use
muted text and a subtle hover fill, with no decorative border around each option. Preserve
keyboard focus and expose the selected filter with `aria-pressed`.

Use the shared icon library and the [icon guide](client-icons.md). Avoid decorative icons that
repeat an adjacent label or add clutter to a compact row.

## Catalog forms

Use [AppSettingsForm](../apps/dashboard/src/components/app-settings/AppSettingsForm.tsx) for
install and installed-app settings. Templates define fields and optional layout hints; the
dashboard owns styling. Keep grouping and column choices in catalog JSON instead of checking
app ids in React. A future preview should use this same renderer.

The [catalog reference](../apps/web/content/docs/reference/app-catalog.mdx#form-layout) documents
`installLayout`, group `columns`, and field `fullWidth`. Preserve value state, visibility rules,
validation, and draft behavior when changing presentation.

App routing defaults follow endpoint intent, independently of the deployment target. Public web
UIs and APIs start with domain routing; raw database ports start internal unless the catalog
explicitly says otherwise. Honor `defaultMode` and `allowedModes`, and preserve saved choices.
Cloud availability selects free versus custom domains; it does not decide whether a UI is routed.

## Checking a change

Inspect light, dim, and dark themes; narrow and wide containers; and expanded and collapsed
navigation. Check keyboard focus, open dropdowns, long labels, and RTL when the layout changes.
Use focused behavior tests for changes to field selection, validation, or payloads. A copy or
spacing adjustment needs visual verification, not a test that asserts a CSS class string.
