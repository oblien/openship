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

## Actions

Actions reuses the shared topology canvas, server selector, page layout and filled
controls. Keep workflow configuration, runner setup and execution history in one
module. Jobs schedules commands or invokes a saved workflow; workflow jobs link to
the original Actions run and its logs. Draw one node
per logical workflow job, with matrix executions in the selectable job list.
Show persisted step state and resumable logs together. Refreshing or switching
views must not discard a running job's state. Only confirm cancellation after the
worker stops, and show cleanup while its destination remains occupied.
Expected cancellation uses its status badge; keep engine cancellation details in
the logs rather than displaying them as a second error alert.

Key remote data by instance, user and organization. Clear private results on a
scope switch while loading the new scope; stale requests must not populate it.
Preserve already loaded logs while polling. Surface capability mismatches beside
the selected destination instead of offering runtimes that cannot execute there.
Native-runner setup explicitly describes access as the connected server user.
Cloud Actions funding is separate from application-server billing and must remain
clearly scoped in the UI.
Actions page titles match Projects: 24px, medium weight, and explicit foreground
color. Use the normal 340px sidebar on the Actions home page, with a themed SVG
workflow illustration for empty workflows, runners and run history. The sidebar
guides first use through runner, workflow and first run, based on the loaded
records; after a run exists, show the current overview and latest run. Keep Cloud
funding and Desktop availability guidance in that column. Use the same loaded
data for the list and guidance, and keep fetch failures distinct from empty
accounts. Stack the sidebar below the list on narrow containers.
Use the same workflow editor from Actions, Project → Actions and the deployment
wizard. The dialog uses the available viewport, with a persistent canvas on the left
and a scrollable 400–420px inspector on the right. Topology is the default; List and YAML
are peer views of the same draft. Source and Run settings stay in the inspector, and
selecting a job or dependency replaces those controls with its editor. Keep Save
visible beneath the inspector. Stack the canvas and controls on narrow screens.
Use the shared PNG `play-circle` icon for Actions in navigation, workflow cards and
the editor. The large editor uses the shared modal's translucent frosted surface;
its inspector uses `bg-popover/60` with backdrop blur. Apply translucency to surfaces,
not text or controls; keep filled fields distinct using the theme's background and
foreground tokens. Workflow nodes are compact neutral rows with a status icon,
job name and runner label, without service-card footers. They reuse the shared canvas
with their own node renderer and compact layout dimensions. Reserve color for run
status, errors and repository differences; plus buttons, sections and configuration
icons stay neutral. The canvas owns its required styles so direct navigation is
consistent with navigation from a project.
Node, step, connection and trigger edits update the original YAML while preserving
unrelated fields and comments. Reject dependency cycles and dangling job-output
references; undo/redo affects the same draft across views. Review repository changes
before committing, using the reviewed file SHA. Offer Automatic repository updates
or Review first; the latter stores the existing inline YAML snapshot and continues
using it until an explicit review and save. Loading a newer repository file must not
overwrite that snapshot or an edited draft. No second sync engine or runner path is
needed. Keep variables, secrets and artifact storage in one disclosure. The wizard
preserves deployment fields while the editor is open and links selected workflows
when the project is saved.
Project Actions owns one deployment policy: Manual, Push, or After required Actions
pass. Its Workflows, Runs and Deployment automation tabs keep the existing project
sidebar; do not add a second settings rail inside the project content column.
Open workflow creation in the same full-width setup dialog used by the deployment
wizard. Show the persisted pending request, exact commit and retry/cancel controls
alongside workflow runs. Required checks cover every push to the project branch;
optional workflows can filter paths. Keep policy failures visible and retryable,
and never start the wizard's deployment before saving its selected rules.
Use **Actions → Budget** for live usage rates, estimated VM minutes, provider
balance and deposit history. Keep the comparison beside a standard 340px funding
column. State that estimates assume full CPU and RAM before transfer or disk I/O;
CPU time, measured memory and transfer consume one balance. Never imply guaranteed
minutes or a separate included transfer allowance. Payment returns reconcile the
saved purchase, then distinguish confirmed funds from runner setup. Preserve page
state and show an unavailable balance as unknown, not zero. Connected Macs default
to native execution and clear incompatible labels when the destination changes.

## Layout and density

Instance relocation has one entry in **Settings → Instance → Instance location**. Keep moving
the control plane, connecting a Desktop, and backup/archive recovery distinct. Reuse the
shared server selector and option cards for API-only versus API + dashboard. Show progress
and recovery in the same card; do not add another direct-transfer or Team migration wizard.
Choose the destination before asking a fresh Desktop user to create an account. Keep that
account form inside the same dialog, retain the server and address, and return to explicit
move confirmation after account setup. Team and push-to-deploy prerequisites link directly
to this flow; a link opens setup only. Use the API's reachability state, so an already-public
instance can enable those features without moving. Show pairing on hosted or connected
instances, and explain that its one-time code connects the person's own Desktop as that user.
A reconnecting Desktop retains its trusted local UI and names the remote instance at sign-in.
The connection dialog starts with one **Instance URL** input, followed by the instance's
existing sign-in or invitation screen. Accept its public dashboard or API-only address;
do not ask users to find a proxy path. Keep one-time account pairing behind a separate
**Use a connection code** action. Connecting never creates a team membership or moves data.
Team invitations offer **Email** and **Copy link**, using the same invitation and role/grant
controls. Email uses the instance's configured delivery capability; link delivery needs no
mail service. Show the link immediately after creation and keep copy/revoke in the pending
list. Shared links use the active instance's public address, including from Desktop.
Recipients sign in or create their own invited account, then enter the accepted organization.
Self-hosted invitation pages offer **Open in Desktop** and a copyable invitation URL. The
app opens its existing connection dialog with that address; it never switches instances or
accepts membership on link launch. Show the instance before connecting, then the inviter,
workspace and offered role on the normal invitation screen. Opening a second invitation on
the same instance preserves the current sign-in. Keep a manual URL fallback visible if the
OS handler or clipboard is unavailable, and offer account switching for a mismatched email.
Desktop queues a later link while a confirmation is open. Its trusted local UI remains loaded;
an external instance never receives Electron's native bridge.
The location card leads with the current computer or server and one contextual action:
move from Desktop, connect a Desktop to an active server, or receive an instance on a retired
server. Put secondary connection and transfer tools in the shared More options menu. Use
plain action labels that distinguish connecting a device from moving instance data. Keep
the summary and actions in one compact row when they fit, stacking them on narrow containers;
do not repeat the location as a separate control-mode badge or a row of competing buttons.
When moving back to Desktop, load portability requirements from the authenticated remote
instance. Reuse the source-host server picker and confirmation; the Desktop's old local
records must not decide which remote host needs an SSH connection. Keep a failed source
check retryable before starting the move.

- Use [PageContainer](../apps/dashboard/src/components/ui/PageContainer.tsx) for its existing
  1600px page limit and responsive padding. Avoid a second page-width cap inside it.
- Project and deployment configuration pages use a 340px action sidebar when there is room,
  then stack on smaller containers. Catalog installs keep their destination and action together.
  Source deployments use the same destination summary above configuration and target-settings
  screen in Cloud and self-hosted mode; do not add a separate destination panel to the sidebar.
- Single-app deployment progress uses 32px phase markers with 18–20px glyphs. Keep the
  connectors centered and separated from each marker by the card-colored ring, with the
  current phase and step count underneath.
- Connected and managed destinations use the same searchable server rows; managed rows show
  project count and purchased capacity in place of an SSH address. Keep the add-server action
  inside the multi-server menu and beside the single-server summary.
- Add Server keeps the connected/managed choice stacked in the right sidebar above setup
  guidance. On narrow screens, place that same choice before the form and guidance after it.
  Reuse the shared acquisition picker in both setup modes and dialogs.
  Selecting Get a managed server on `/servers/new` opens Billing's explicit new-server
  purchase. Keep inline destination dialogs in place so they preserve the deployment form.
  Cloud Add server opens plan selection first. Reuse the same plan and Custom purchase
  component in Billing, managed server setup and destination dialogs. Create the server
  with its default name only after a plan is chosen, then use the shared scoped checkout.
- Destination settings use the normal page layout: server selection first, then visible
  runtime, resource and rollback sections, with a 340px preview/Continue sidebar. Keep the
  same layout in Cloud and self-hosted mode; do not hide it in an Advanced accordion.
- Machine power defaults to the full available server capacity. Project settings and
  deployment setup share the resource editor and tier labels. Optional limits apply to
  containers; the managed server's purchased allocation stays separate.
  In destination settings, offer Full capacity and Customized as peer selection cards;
  Customized keeps the presets visible below. Keep a Back action in the page header.
- Project Settings presents curated app fields and project-wide controls in one flow.
  Keep shared environment, machine power and rollback settings there, including for
  Compose and monorepo projects. Apps & Services owns the service list and per-service
  editors; do not embed that page or add App settings / Deployment modes inside Settings.
- Destination, runtime and resource choices share [OptionCard](../apps/dashboard/src/components/shared/OptionCard.tsx),
  including its selected border and radio marker. Do not introduce a separate switch style.
  New single-app setups default to Direct on servers with less than 2 GiB RAM, using
  purchased capacity when available and live monitoring otherwise. Preserve saved projects
  and explicit source/user choices; Compose and image workloads keep their Docker runtime.
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
  Cloud and Cloud-connected installations add Support as the final entry, under Help.
  Keep it reachable for existing Cloud projects if the connection needs attention, using
  the sidebar's loaded project inventory. The private support center uses a
  searchable ticket list beside a conversation or new-ticket form, stacking on narrow
  containers with a Back to tickets action. Use the shared theme surfaces and controls.
  Tickets belong to the signed-in account, not its selected team. Keep the draft after a
  failed send and reuse the request identity on retry; switching accounts clears private state.
  Connected local installations use the person's own verified Cloud account and show its
  email. A shared team connection never exposes its owner's private inbox to teammates;
  offer a Cloud sign-in link when the current person has no personal link.
- Projects and catalog Apps have separate top-level sidebar entries and lists, backed by the
  same project data and status handling. Apps uses a compact installed list with Home's
  app illustration and a link to the full catalog alongside it. The illustration's icons
  link to available catalog apps; keep their targets stable and do not repeat them in a
  second suggestion list. Its empty state shows connected app logos and popular install shortcuts.
  Keep Home's project list and the sidebar counts separate too.
- Cloud's New Project choices are Apps, GitHub, Git URL and Import existing project.
  Folder import and the Browse Templates shortcut are available only on self-hosted instances.
- Credit warnings belong in Billing's overview for the selected server. Reuse its loaded
  billing state and scoped links; keep the notice inline. Monthly servers have no compute
  credit warnings. Other pages do not mount a credit tray or poll all server balances.
  Transfer uses the provider's current-period usage and explicit unlimited benefit.
  Zero available bytes alone does not mean blocked access; respect its grace/status.
  Expired compute coverage never presents an unlimited benefit as active access.
- Plan comparisons lead with CPU, memory, storage and service/project limits. Keep build
  time separate from runtime capacity; show minutes only when the offer defines a time
  allowance. Summarize monthly coverage and shared capacity in the common checklist
  below the comparison, alongside shared capabilities. Keep additional transfer, backup
  and storage terms in a compact disclosure. Follow this with the catalog's Enterprise
  contact card; do not repeat these details inside every plan or in a separate text card.
- Cloud billing keeps its header and tabs mounted when switching servers. List managed
  servers in the right sidebar on usage and history tabs, reusing the shared destination rows.
  One server is a summary; several servers switch billing directly from the visible list.
  Keep one Get server action in the page header across billing tabs; the sidebar only
  selects the server being inspected. Plans keeps the shared compact server picker beside
  that action. With one or two preset choices, show the saved subscription and capacity in
  the standard 340px right column when the container has room; stack it first on smaller
  screens. Keep a single priced offer at a maximum of 26rem, shrinking to the available
  width on small screens. Complimentary-plan support guidance belongs inside the saved-plan
  summary; dialogs without that summary retain their inline guidance. Wider comparisons and
  Custom keep the compact summary below the tabs. Use the
  picker's displayed choices for this layout too; an inactive subscription uses a short
  inline notice. New purchases use the plan introduction
  as the page title and description. Keep Plans / Custom beside Back to billing in the
  header, using matching 40px controls. Purchasing does not require a server-name field.
  An existing server without a plan keeps the server selector, including when every
  server is unpaid. Only an explicit new-server purchase replaces it with Back to billing.
  Do not repeat the introduction below the page heading. Default to relevant upgrades; offer
  Other plans deliberately for lower-cost changes and Custom when no larger preset fits.
  Do not call today's catalog terms the current plan if they differ from the saved purchase,
  or offer a preset that would shrink an existing disk. New-server purchases have their own
  explicit entry and never inherit the selected server's billing scope.
  Unscoped billing opens an existing subscription directly; never
  auto-switch a checkout return or an explicitly selected server. New customers see only
  Monthly server and Pay as you go in the existing top tab bar, without empty billing-history
  tabs. Reuse the same purchase controls in server setup and destination dialogs. Switching
  these views keeps resource inputs and never starts a purchase. The page's purchase
  tabs sit directly above the plan cards. Standalone setup and destination dialogs reuse
  the same Plans / Custom control beside their tabs, without a separate page header. Until a usage
  offer is supported, show its unavailable state without invented rates or a checkout action.
  Keep normal billing navigation for existing subscriptions, allocated servers and credit history, including stopped or
  canceled servers. Show current plan, renewal date or inactive subscription state for
  existing servers; never replace those with a first-purchase promotion.
  In-app credit alerts
  link directly to the scoped billing tab; only a genuine organization change needs
  authorization and a context reload.
  Payments and invoices share one tab and the existing scoped Stripe portal. Show Top-ups
  only when the billing API enables them for the selected server; the purchase-view choice
  must never override paid terms or provider entitlement.
  Keep Pending payments accessible in the Billing header even for unpaid servers. Cloud
  lists unfinished payments across the organization's servers. Connected installations
  use the same Cloud inventory, filtered to a selected server when requested, without
  creating local execution links. Preserve local aliases for explicitly linked servers
  and clear payment state when the connected Cloud account changes. Reuse the same compact recovery list in
  Payments and in the unfinished-checkout dialog. Show saved offer terms and the server
  name, with Resume and provider-supported cancellation. Never present a pending or
  unknown cancellation as complete. After confirmed cancellation, offer another plan
  and reuse the existing delete confirmation for an unused, unpaid server.
- Monthly servers show purchased resources, paid-through coverage and measured CPU time;
  they have no compute-credit donut, exhaustion alert or credit top-up action. Keep optional
  managed proxy transfer and retained-storage charges distinct from compute coverage, with
  details in a compact disclosure. Existing metered subscriptions retain their credit view.
  Prepaid PAYG shows package amounts beside their credit value, using the provider's
  conversion and published resource rates. Keep the Openship resource tiers inside the
  resource card, using compact shared tabs above its inputs. Present the selected tier's
  CPU, RAM, disk and server-count limits as plain capacity values in a compact summary
  that wraps on smaller screens. These limits stay fixed while configuring a server.
  Keep the cumulative credit-purchase threshold by the tabs
  and the selected package's qualifying tier in the credit card. These are pool ceilings,
  not monthly subscriptions or a copy of the reseller owner's Oblien plan. Spending
  credits never lowers a tier. Keep credit-package and resource-tier selections separate;
  changing either must preserve resource inputs. An oversized configuration should show
  which limits are exceeded and offer the smallest available tier that fits, without
  silently resizing the user's servers. The catalog and unlock display remain a preview
  until verified customer funding and runtime entitlement are connected.
  Reuse the monthly resource editor for the interactive estimate, with two resource
  controls per row when they fit. Configure one server; show its hourly price at full
  CPU usage and state that basis beside the estimate. PAYG prices come
  directly from usage rates and do not depend on
  monthly-plan quotes or ceilings. Keep the pricing preview until customer-funded
  purchases are supported. A shared balance is funding,
  not a multiplied resource pool; estimates for several hosts must spend that balance
  once. Use three columns when space permits: the resource editor, readable credit
  package rows in the middle, and the 340px estimate card on the right, aligned at the top.
  Keep the CPU-hour explanation and rate details with the estimate. Give packages
  280–320px and let the resource editor use the remaining space. Stack the
  packages below resources at intermediate widths, then stack all sections on mobile.
  Monthly and PAYG share the catalog's Enterprise contact card at the end of the picker.
  Keep one compact purchase bar visible at the bottom while configuring resources;
  use a translucent popover surface with backdrop blur while keeping its text readable.
  Lead with estimated dollars per hour and the matching credits per hour, with
  the per-server scope and full-CPU basis beside them. Keep the CPU, RAM and storage
  hourly breakdown visible. Do not turn a full-month projection into a purchase
  requirement or suggest a larger deposit to cover it. Balance duration belongs in
  an optional disclosure and follows prepaid funds divided by resource usage cost;
  reserved RAM and storage stay included at full and idle CPU. A monthly spending
  ceiling requires an enforceable provider quote, not a UI-derived promise.
  Show CPU-hours as allocated vCPUs multiplied by average activity and elapsed time;
  label time online as elapsed time. Show resource-hours and their costs under a clear
  per-elapsed-hour heading for the configured server. Distinguish active CPU from
  reserved RAM and retained storage. Keep checkout unavailable until customer-funded purchases are
  supported. Do not expose reseller wallet balances or call hypothetical comparisons
  recorded savings.
- Custom resources sit beside the preset plan choice. Keep CPU, RAM and disk controls
  with a compact monthly total, wait for a matching server quote before enabling
  checkout, and expose bundle pricing details on demand. Applying a paid resource
  change reuses the server's affected-project review and restart confirmation.
- Existing subscriptions use a compact plan-change review, with provider prices,
  amount due now, effective date and affected projects. Keep these details in the
  scrollable body and use the shared server resize summary. Upgrades activate
  after payment; downgrades wait for paid renewal. Keep pending payment and
  cancellation actions in the selected server's billing card, preserve retry
  identity after uncertain responses, and never replace the page with a loader.
- Checkout returns verify payment, paid coverage and managed-server readiness separately.
  Show the subscription welcome only when setup is complete. Keep preparation and failure
  notices compact and above the billing columns, with a recheck action and a link to the existing server Activity tab
  for logs and retry. A paid setup failure must never direct the customer to pay again.
  The welcome names the purchased server, shows its saved CPU, RAM and disk, and links to
  that server and its billing. Remember dismissal per customer, server and checkout.
- Unavailable server capacity or checkout opens the shared compact checkout feedback dialog.
  Preserve the selected resources, server and retry identity. Offer an explicit email-update
  request through the signed-in Cloud support inbox; confirm it only after a saved receipt
  and link to the resulting ticket. Use the session email for replies.
  Explain that the support team follows up, without promising an automatic inventory alert.
  Connected self-hosted installations offer direct email contact; Cloud intake accepts
  browser submissions only from its trusted dashboard origins.
- Plan cards respond to their container: one column on phones, two at intermediate widths,
  and four when readable. Offer links to each plan above a stacked comparison; never rely
  on hidden horizontal overflow to reveal additional plans.
- Deployment plan dialogs use compact title and action rows. Keep explanations in the
  scrollable content so the plans receive most of the available viewport height, including
  on short screens. Keep actions side by side on phones, allowing long labels to wrap.
- On `/billing/plans`, collapse the desktop sidebar automatically for comparisons with
  three or more visible plans and the PAYG configurator. One or two upgrade choices,
  Custom, and loading or error states keep the normal sidebar preference. Use the picker's
  displayed choices; navigation must not fetch or filter plans again. Keep manual toggles
  across filter and purchase-view changes. The Scale canvas still opens collapsed; restore
  the normal preference on leaving and keep its override separate. Mobile navigation opens fully.

## Typography and copy

Account protection lives in **Settings → Security**, using the existing settings
navigation and section cards. Keep authenticator setup, recovery codes, and
passkeys together for accounts hosted on that instance. Enrollment verifies a
code before showing protection as enabled; setup keys and recovery codes stay
inside that account's current flow and clear when the account changes.

Use the existing Gellix / SF Arabic font stack and semantic text colors. `text-sm` is 14px;
the dashboard overrides `text-xs` to **13px**, with a 20px line height.
Use `text-sm` for field labels, controls, and primary list information; use `text-xs` for hints
and supporting metadata. Match nearby page headings instead of introducing a new size scale.

Use **Domains & routing** for sections covering domains, published ports, and internal access. Use
**Domains** when the section only manages hostnames. Put shared UI copy in the locale dictionaries.
Keep hints concise and explain choices where they help the user decide.

Routing retries keep their logs inline and reconnect to the same server operation after a
refresh. Refresh domain status and the routing warning from the canonical project response;
do not clear one optimistically. A domain card has one primary repair action, including when
its diagnosis is expanded. Hostnames owned by another service display that service's verified
certificate state without offering project-owned certificate actions.

Connection failures describe unavailable observations. Use the shared
[ConnectionNotice](../apps/dashboard/src/components/shared/ConnectionNotice.tsx) with concise warning
copy and a read-only status retry where available. Keep last-known details, label current health
unknown, and reserve repair/setup prompts for confirmed states. The root layout owns the browser/API
connection notice. Monitoring groups explicit network failures across affected servers and keeps
raw diagnostics in a closed Technical details disclosure.

Service terminals distinguish a pending status read from a confirmed stopped service. Keep the
terminal mounted when a status check becomes unavailable; offer a manual terminal connection
while status is unverified, using the same authenticated PTY transport. Use the shared terminal
shell and connection notice for checking, unavailable and stopped states, with a status retry
and a relevant next action. Connection attempts can be cancelled. After a session has connected,
show reconnect feedback above its retained output instead of covering or replacing it.
When a shell opens, refresh the canonical service status; do not mark it running optimistically.

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
