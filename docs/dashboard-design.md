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
Runtime version, build image, and runtime image selection belong in a visible **Runtime** section of the
existing deploy wizard. Use the shared filled dropdown and inputs. Derive supported versions and
managed image defaults from the stack's runtime policy; show incompatible custom overrides inline.
Blank resets an image override. Unsupported destinations explain which source or server owns the
runtime, and saved overrides remain visible so users can clear them. Static Docker builds show
only the build image. Do not repeat these fields under Advanced. The saved project Configuration
card shows the selected runtime version.
Build-location choices and summaries describe execution, independently of source cloning.
Keep local building in the destination's advanced controls only when the runtime supports it.
Remote Docker, static sandbox, service, managed Cloud and cluster builds name their build
destination; a stale local-build preference must not advertise work on Desktop. Preserve the
separate clone-location choice and existing source behavior when hiding unavailable builds.
Image updates belong in the existing project and service Redeploy dropdown. Reuse the same
**Refresh images & redeploy** and **Check image updates** actions for every stack, including
prebuilt image services. Refresh preserves configured versions and digest pins. Image drift uses
the existing compact recommendation notice and direct redeploy action; unknown baselines are never
reported current. Record image identities in deployment metadata without executing interpreter
probes. Cache clearing only clears cache; it never schedules a future runtime update. Restart and
environment refresh do not imply an image update or automatic security coverage.
Security advisories reuse those deployment actions and the existing root UpdateCenter
banner. **Review affected apps** opens a shared dialog; do not repeat notices in
project Deployments or service panels. Group evidence and actions by affected app
inside the dialog. The compact banner names only the apps and services affected by its
advisory, with observed runtime versions. Monitoring → Security retains active findings
independently of banner dismissal and reuses the same review component and cached overview.
Keep detailed guidance and automatic-update settings in disclosures; show unknown/stale
coverage and inspection time without claiming a complete vulnerability scan.
Reading the root banner aggregates current observations without container exec;
new/changed rules are inspected by the bounded background job.
Automatic security refresh is an explicit, off-by-default project switch with
its limited scope explained beside it. Keep per-channel security alert controls
in Settings → Notifications. Runtime security checks may use cached, bounded
version probes inside isolated containers. Keep **Check again** beside the last
inspection time; it refreshes evidence without deploying. Image drift checks remain receipt-based.
The failed deployment page offers **Retry deployment** only when the server reports a retained
completed image. It replays that attempt's saved configuration with no build or replacement image
pull. Keep ordinary **Redeploy** available for a new build. Routing-only warnings use the existing
Domains retry action; do not turn those into image rebuilds.
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
Show persisted step state and resumable logs together. GitHub mode uses the same
step presentation, with a direct link to live GitHub logs and completed logs in
Openship. Preserve GitHub-owned Checks instead of publishing duplicate status. Refreshing or switching
views must not discard a running job's state. Only confirm cancellation after the
worker stops, and show cleanup while its destination remains occupied.
Expected cancellation uses its status badge; keep engine cancellation details in
the logs rather than displaying them as a second error alert.

Run details defaults to a collapsible job-and-step list beside the selected log.
Keep each job's expansion independent, and share selection and one resumable log
loader with the optional Topology view. Store the selected job, step and view in
the URL so refresh restores them. Topology reuses the editor's Arrange, fit/zoom
and Expand all / Collapse all controls. Pack disconnected jobs across the available
space; preserve dependency columns and arrows. A single job shows its connected
step cards immediately. Keep the log beside the graph on wide screens and stack
the navigation above it on narrow screens. GitHub's completed log is supplied for
the whole job; label that scope when a step is selected instead of inventing step
boundaries. Independent step logs use their recorded step IDs.
Queued and waiting states use the same yellow, motion-safe loading indicator as
active jobs, while keeping their distinct status labels. Run approval lives in the
third **Approvals** tab with a yellow attention icon when review is needed; never
place an approval card above the run workspace. Keep the current job, step and log
cursor mounted while reviewing access. Refreshing restores the tab, and an approved,
cancelled or finished attempt cannot retain an actionable approval card.

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
are peer views of the same draft. Source and Run settings stay in the inspector.
Use the shared canvas skeleton with compact workflow nodes while editor data,
repository discovery or the canvas code loads. Keep the current graph visible
while validating edits. An empty canvas starts with one actionable workflow node;
reserve the large illustration for the Actions home empty state.
In Topology, selecting a job or dependency replaces those controls with its editor.
In List, expand jobs and edit steps independently on the left; keep workflow controls
on the right. Reuse the same job-and-step editor in both locations without rendering
a duplicate. Job settings open by default when selecting a topology node and remain
a compact disclosure in List. Expanded steps stay in shared state across views;
opening an item never closes another. Keep Save
visible beneath the inspector. Stack the canvas and controls on narrow screens.
Use the shared PNG `play-circle` icon for Actions in navigation, workflow cards and
the editor. The large editor uses the shared modal's translucent frosted surface;
its inspector uses `bg-popover/60` with backdrop blur. Apply translucency to surfaces,
not text or controls; keep filled fields distinct using the theme's background and
foreground tokens. Workflow nodes are compact neutral rows with a status icon,
job name and runner label, without service-card footers. A muted info accent on the
draft's play icon and selected outline gives identity without tinting the node fill.
They reuse the shared canvas with their own node renderer and compact layout dimensions.
A job expands into separate step cards below its compact job node, without an enclosing
box. Choose the grid columns from the available canvas width and height, reserving space
for neighboring jobs through the shared layout. A single-job workflow shows its steps
immediately; the editor toolbar offers Expand all / Collapse all for larger workflows.
Directional arrows follow YAML execution order across each row and down to the next;
job dependencies remain connected to the job. Selecting a step node reveals its
shared step editor. Each card remains independently movable and each job can still
expand independently. Reflow when the canvas size changes; preserve manual positions
while editing fields or selecting nodes.
The List view is a vertical job outline with expandable steps and explicit dependency
labels; its rail does not imply execution order or completed progress. Reserve other
color for run status, errors and repository differences; plus buttons, sections and
configuration icons stay neutral. The canvas owns its required styles so direct navigation is
consistent with navigation from a project.
Node, step, connection and trigger edits update the original YAML while preserving
unrelated fields and comments. Reject dependency cycles and dangling job-output
references; undo/redo affects the same draft across views. Review repository changes
before committing, using the reviewed file SHA. Repository discovery selects the
integration from the file path; do not expose engine-selection tabs. Files in
`.github/workflows` use GitHub's scheduler and the selected Openship runners;
standalone YAML and `.openship/workflows` use the independent controller.
Repository preview and saving follow the same rule, including existing drafts.
GitHub workflows always commit changed YAML,
use repository-managed credentials/storage, and explain the explicit
`self-hosted, openship` routing labels and repository-wide runner trust. Independent
workflows offer Automatic repository updates or Review first; the latter stores the existing inline YAML snapshot and continues
using it until an explicit review and save. Loading a newer repository file must not
overwrite that snapshot or an edited draft. No second sync engine or runner path is
needed. Keep variables, secrets and artifact storage in one disclosure. The wizard
preserves deployment fields while the editor is open and links selected workflows
when the project is saved.
Repository setup offers a compact file checklist with Select all. Keep a separate
draft and undo history for each file while previewing them on the same canvas.
Keep repository entry, the picker and refresh on one row, with icon buttons
and accessible labels; branch/tag selection follows underneath.
Below repository entry, offer a direct **Use a custom workflow instead** shortcut to
Standalone. Initialize new workflow names from their validated YAML, preserving
explicit edits and cleared names. A blocked Continue or Save action has a compact
inline requirements list above it; each actionable requirement opens the relevant
settings or YAML editor. Keep validation-in-progress distinct from an invalid draft,
and use the neutral workflow icon for canvas guidance, without a brand logo.
Runner destinations, enabled state and project links apply to the selected files;
trigger edits belong to the previewed file. Review every changed file before a
repository commit. Import files and links in one transaction; a retry reuses saved
workflows and preserves their configuration.
Keep the active workflow file visible beside its trigger controls, with a compact
file selector for a batch. Switching files updates the canvas and trigger editor together;
never present an unloaded file as having another file's conditions. Show branch, path,
tag and event-type filters in collapsed trigger rows so their scope is visible immediately.
Run settings uses compact trigger rows with shared switches and expandable controls.
Branches, paths, tags and event types use filled add/remove chips; keep commas inside
glob patterns literal. Include/exclude choices replace the opposite YAML filter.
Schedules have individual UTC inputs, and additional YAML-only events remain visible.
Keep the Workflow / Run settings / Access / Checks tabs and save action visible while the inspector scrolls.
Project and deployment entry points keep their project association implicit; the generic
editor puts additional project links in a closed disclosure and preserves links when untouched.
Run settings leads with the required runner destination. Selecting an empty runner field
opens the shared runner form in a modal; saving returns to the same workflow draft and selects
the new runner. Existing runners use a compact picker. Its rows, selected value and runner
cards share an execution summary: OS, Docker/native mode and verified native/emulated CPU
architectures. Do not infer capabilities from custom labels. Put the host OS/version,
default image, resource limits and routing labels in a closed details disclosure; opening
details must not change selection. Keep unverified and failed probes visible.
Cloud funding opens the shared budget
in a dialog; only hosted payment opens separately so the draft survives.
Access replaces the blanket runner-consent checkbox with a policy: who may run,
whether each run needs approval, and whether fork pull requests may use disposable
Cloud runners. Default to the connected account, approval for each run and forks blocked.
Keep the policy when changing selected files or runners; reset it when changing repositories.
Use verified GitHub account identities for selected users. Keep GitHub protection settings
one link away and explain that those protections still apply alongside Openship approval.
Run approval shows the commit, attempt, requester and destinations before execution.
Missing destination details remain retryable; readers see who can approve instead of a
button they cannot use. After a rejected approval, refresh the run so an old review cannot
remain actionable. Blocked access links back to workflow settings.
Checks shows the connected GitHub identity, selected repository and verified reporting
availability in a compact row. Keep account connection distinct from repository permission;
show a direct Connect, Review access or Retry action instead of assuming automatic reporting.
Use the existing GitHub connection controls in a dialog without discarding the workflow draft.
Notification channels are added and verified in an inline dialog using the shared Settings
form. Show a single Add channel action, use the created channel only after verification,
and keep optional outcome choices compact. Do not send users to another page to finish setup.
Account-wide subscriptions and workflow choices share one durable delivery identity per run
and channel; changing notification choices affects future runs, not runs already in progress.
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
In Cloud, Add runner opens the capability form directly with the shared Cloud space
picker. It uses the space's existing capacity and billing; do not add a server-purchase
or temporary-VM choice before the form. Self-hosted setup offers an existing server
or the shared managed-server acquisition flow, returning to the same capability form.
Temporary Cloud profiles and their funding remain in the existing runner list and
Budget dialog. Preserve the workflow draft and distinguish failed reads from empty
results. Explicit per-job capacity limits remain optional.
The capability form starts with the shared server picker and a compact environment summary.
Browse catalog opens visual Ubuntu, native macOS/Linux and custom-image presets using
the shared logos and option cards. Only offer presets compatible with the inspected
server. Presets fill the existing runner configuration and keep resource limits; new
connected runners get OS/architecture labels from the capability probe, without implicit
Ubuntu-version aliases. Preserve saved runner labels during inspection. Presets
do not create another execution path. Keep image, labels and resource overrides under
Advanced settings, with the current configuration and matched labels in the sidebar.
Retain saved runner settings on inspection, and make missing-tool checks retryable.
The default environment is a convenience, not a limit on job images. Job settings
can choose a Linux container image and one CPU architecture using standard YAML.
Show verified native/emulated architecture badges on container runners. Offer explicit
CPU emulation setup only for a Docker-capable server; keep the destination locked while
it runs and recheck capabilities before displaying the result. Native Macs continue to
use their installed tools and physical CPU.

## Layout and density

Project navigation groups metrics, runtime/request logs and available Health views
under **Monitoring & Logs**. Runtime-health attention on project cards opens the existing
Health view and clears from the same incident state when a workload recovers;
a successful deployment remains a successful deployment. Reuse the shared project section tabs above the content
on desktop and mobile. Keep existing section URLs so saved links and log shortcuts
open the same view, and show Health only where the project already supports it.

GitHub deployment reporting uses the same compact settings card in Project → Source
and the shared deploy wizard. Lead with one enabled toggle and a short description;
keep overall/per-service selection and failure-detail sharing under Customize checks.
Retain selections when reporting is disabled, a branch is rescanned, or the wizard is
reopened. Delivery failures belong beside these preferences, with the GitHub connection
link, and must not replace deployment status or appear as a build failure.

Monitoring includes a Notifications tab for account-owned channels, organization
alert preferences, and personal delivery history. Settings keeps the same shared
editor for existing links. Show enabled and verified states separately: a paused
or unverified destination is not ready to deliver. Verification sends a real test
only after an explicit click. Keep recent delivery outcomes distinct from incident
health; reading history never marks messages seen or retries an external send.
Private drafts and delivery results reset on account, organization, and instance
changes. Load errors must not look like an account with no channels.
Read preferences and organization defaults together. A failed defaults read must
show an error and Retry, never editable empty defaults. Preserve a previous
successful snapshot on refresh failure, with preference controls disabled until
a successful retry.

Alert preferences keep both switches at the start of the controls row and only the channel
picker at the end, wrapping on narrow screens. A header search button reveals a local filter over alert names
and descriptions within the selected category tab; closing it clears the filter. Channel
cards keep Edit and Delete in a top-end More menu, while Send test sits at the end of its row.
Notifications has inline Channels & alerts and Delivery history tabs. Load history only when
opened, use server-backed newest-first pagination, and retain channel drafts when changing
tabs. Refresh returns to the latest page; browsing history never acknowledges deliveries.

Global deployment history lives in Monitoring’s final Deployments tab. Lead with server-side
7/30/90-day outcome totals, a daily chart and a project breakdown, followed by the history.
Project and search filters scope both; status filters drill into the history without changing
the summary denominator. Use UTC calendar days and label the retained-history scope. Exclude
cancellations and unfinished attempts from success rate; count queued attempts as in progress.
Each project retains its own history.
Old `/deployments` links redirect to Monitoring while preserving filters.

Instance relocation has one entry in **Settings → Instance → Instance location**. Keep moving
the control plane, connecting a Desktop, and backup/archive recovery distinct. Reuse the
shared server selector and option cards for API-only versus API + dashboard. Show progress
and recovery in the same card; do not add another direct-transfer or Team migration wizard.
Keep **Connect to an existing instance** and **Move to a server** visible on Desktop.
A connected Desktop shows **Reconnect** and **Move back to Desktop**. An active server
shows **Connect a Desktop**, **Move to another server**, and **Move to Desktop**.
Reserve More options for receiving an instance, returning to the local instance, and
previous-server recovery; do not repeat visible actions in that menu. Stack the shared
buttons on narrow containers. Distinguish connection, move, and receive codes by name,
and show where to generate and paste each one. Receiving offers explicit choices to
paste a move code or create a receive code; never interpret a blank field as consent
to generate a code. Changing the destination or receive method requires fresh consent.
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
  Keep its default top padding for page headings, including Billing.
- Project and deployment configuration pages use a 340px action sidebar when there is room,
  then stack on smaller containers. Catalog installs keep their destination and action together.
  Source deployments use the same destination summary above configuration and target-settings
  screen in Cloud and self-hosted mode; do not add a separate destination panel to the sidebar.
- Project navigation places Monitoring & Logs before Actions. Keep the Monitoring, Logs and
  Health section tabs underlined; use the shared compact filled tabs for log-source selection
  inside Logs. Hide that inner selector when only request logs are available.
- Single-app deployment progress uses 32px phase markers with 18–20px glyphs. Keep the
  connectors centered and separated from each marker by the card-colored ring, with the
  current phase and step count underneath.
- Completed service startup warnings offer a read-only health recheck and a logs link.
  Briefly follow starting healthchecks on the visible page; failed reads expose retry.
  Only a reported healthy result for the same active deployment resolves the startup
  advisory. Preserve its original warning as history and leave unrelated warnings intact.
- A host-port conflict uses the shared deployment decision dialog. When the API offers a
  verified alternative, show its exact port as the primary action and explain that choosing
  it keeps the existing service running. Keep stop actions explicitly destructive; a changed
  suggestion requires a new choice. Reuse the same prompt after refresh.
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
  containers; the managed server's purchased allocation stays separate. Catalog
  sizing is advisory. Unset build and service dimensions receive no additional Docker
  limits; Cloud admission reservations must not appear as user-configured caps.
  In destination settings, offer Full capacity and Customized as peer selection cards;
  Customized keeps the presets visible below. Keep a Back action in the page header.
- Project Settings presents curated app fields and project-wide controls in one flow.
  Keep shared environment, machine power and rollback settings there, including for
  Compose and monorepo projects. Apps & Services owns the service list and per-service
  editors; do not embed that page or add App settings / Deployment modes inside Settings.
- Ready native databases use the existing **Use in a project** connection modal.
  Preselect the opened database, keep its credentials masked, and offer writable
  consumers on the same native cluster. Explain incompatible placement inline;
  never expose a public connection option for a native database or copy its ownership.
  Other outputs from a source project keep their existing target choices when no
  native database is selected. Connection errors must remain visible and allow retry.
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
  Backups belongs under Infrastructure beside Servers/Resources, Emails and Jobs, in every platform mode.
  Missing-edge warnings use the API's routing requirement, independently of the total project count.
  Private workloads and workers keep the optional install action without an outage/attention indicator.
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
- Backups uses a compact storage summary above full-width history and destination sections.
  The project tab uses the page's Backup title once; keep Refresh right-aligned above the summary
  without a second heading or introductory description.
  Keep secondary descriptions quiet, and stack history rows on phones while retaining dates,
  sizes, payloads and restore/detail actions. Destination detail pages retain their sidebar summary.
- Keep project grid cards within their original compact footprint. Put identity and domain
  beside the shared More dropdown, followed by a quiet status, destination and timestamp row.
  Keep service, deployment and log shortcuts left-aligned at the bottom as content-width
  `bg-muted` controls, which lift in dim/dark themes rather than using the recessed input background.
  Live sits at the bottom-right with the existing `ServiceStatusIndicator` hollow ring and muted text, without a filled pill; keep attention states
  prominent and preserve their action links. Give More menu items their shared icons.
  Show Services only when the persisted count is positive; never invent a count.
  Keep Projects loading inside the same search/view layout, with skeletons matching the
  selected grid or list view and the grid’s actual column widths and card spacing. Reserve
  the same responsive 340px right column while loading, with filter and guidance placeholders.
  Use flat theme surfaces and color-only hover feedback, with no drop shadows, elevation
  or hover movement. Project names use 16px text, domains 14px, and metadata/status 12px;
  do not shrink metadata to 10–11px.
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
- Plan comparisons lead with CPU, memory, storage and the offer’s support level. Show
  finite project, service and build-concurrency allowances when the offer defines them.
  Omit per-service ceilings and repeated unlimited rows. Preserve saved plan terms. Keep build
  time separate from runtime capacity; show minutes only when the offer defines a time
  allowance. Summarize monthly coverage and shared capacity in the common checklist
  below the comparison, alongside shared capabilities. Keep additional transfer, backup
  and storage terms in a compact disclosure. Follow this with the catalog's Enterprise
  contact card; do not repeat these details inside every plan or in a separate text card.
- Billing uses one navigation for overview, usage, plans and payments. Plan selection
  offers Cloud plans, Prepaid PAYG and Manage your server, in that order. Manage opens
  the shared management subscription view; do not repeat it as a compute-plan card or
  a separate Cloud/Manage product switch. Its coverage and allowance belong to the
  workspace, independently of the selected Cloud server. Load it only when selected.
  Preserve Cloud form state when switching views. Hide Cloud capacity controls while
  Manage is open and disable switching while checkout is in progress. Deployment and
  server-acquisition dialogs retain their compute-only choices. The direct Manage URL
  remains available for payment returns and reuses the same view.
- The affiliate program is labeled **Earn** in the sidebar and page heading, with
  the shared `gift` icon in the sidebar. It uses full-width tabs for links,
  customers and payout history. Keep the
  four earnings cards above the tabs. Place program terms and first-use guidance in
  the standard 340px right column below the tabs, stacking beneath the list on narrow
  containers. Reuse the loaded overview for these terms, keeping each program's
  commission budget and reward duration paired. Enrollment and empty lists use neutral
  layered-card SVG illustrations from the Actions/Backups family, with an actionable
  heading and no invented earnings or success indication.
  Keep the minimum beside available earnings. Show Request payout only for an enabled participant
  with enough available funds, opening the shared modal on demand. Public referral pages
  reuse the Cloud catalog, pricing cards and interval control; a chosen plan continues
  through sign-in to the existing checkout with its referral intact.
  Link creation starts with a compact discount step, then expands to plan and billing
  interval selection with per-payment earnings. Use one card per plan with monthly and
  yearly choices inside; the whole choice is a keyboard-accessible checkbox. Keep link
  name, commission terms and optional expiration in a compact side card on wide screens.
  Distinguish all eligible plans (including
  future plans) from explicit checked combinations. Annual earnings use the full annual
  payment. Separate the customer's billing cadence and charge from the affiliate's
  commission per confirmed payment. Explain that earnings start with the first payment,
  without waiting for the billing period to end. Renewal copy follows the program's
  reward window: a 12-month window covers the first annual payment, not next year's
  renewal. Cash payout approval remains a separate flow. The public referral page must
  choose a supported interval automatically.
  Use shared filled controls and checkboxes; keep the actions fixed while the body
  scrolls. Expiration is optional and separate from the reward period. The Payouts
  sidebar shows locally bundled, original payment-provider artwork and supported manual
  methods. Reuse those marks in visible radio cards for choosing a payout method and in
  saved-account summaries. Account editing opens a separate modal with method cards
  beside the recipient fields, stacking on narrow screens. Keep masked summaries in
  account and history views.

- Cloud plan purchases place the compact Monthly / Yearly control before Plans / Custom
  in the same purchase header. Use the existing secondary fill for the selected interval;
  do not add a decorative ring or another label row.
  Default new purchases to Yearly, while preserving a saved
  subscription or an explicit monthly purchase intent. Show it only when the provider enables annual purchases.
  Yearly cards display a monthly equivalent with the full annual charge directly below;
  checkout charges that full year. Custom uses the same interval and resets its quote
  on interval changes. Existing subscriptions keep their saved interval; Manage remains
  monthly. Disable interval changes during checkout and never reuse a quote from another
  interval. Do not add another product navigation or price calculator.
- Manage uses standalone Basic and Priority pricing cards matching Cloud's card spacing,
  icons and typography. Keep the native radio selection, with a neutral filled action
  and checkmark inside each card; reserve the primary fill for checkout. Do not wrap the
  comparison in another large card. Place the introduction above the comparison grid so
  the right card starts level with the plan cards. Keep shared benefits, server count,
  monthly total and the full-width checkout button together in that right card, stacking
  it below the plans on narrow containers. Keep the total and checkout action in a sticky
  footer while the details scroll. On mobile, pin that one footer above the safe area and
  reserve room below the content; short desktop windows use the stacked comparison so the
  footer remains visible. Keep checkout validation and pending-payment restrictions intact.
  Explain app deployments and image updates,
  health checks and alerts, resource
  monitoring, domains/HTTPS, scheduled backups and API access. Do not replace these benefits
  with a self-hosting pitch or promise unattended OS/app patching. Basic includes email
  support and Priority includes priority support. Both use the same server allowance,
  checkout recovery and paid subscription verification. Keep the selection distinct from
  the verified paid support level. Paid Cloud includes Basic; Priority retains its support
  fee. Use existing theme fills, selected checkmarks and controls, with no new product switch.
  Show the infrastructure summary once an allowance is active; an unpaid first visit does
  not need an empty server-usage card. Adapt comparison columns to the available container.
- Add Server reuses Billing's Manage purchase component inline when a Cloud workspace has
  no active allowance or all its slots are used. Share pricing, payment recovery and
  subscription changes; do not send users elsewhere just to start checkout. Keep the
  server form gated on the verified allowance, and reset the purchase state on account,
  organization or instance changes. Self-hosted connection forms stay unchanged.
- Cloud billing keeps its header and tabs mounted when switching servers. List managed
  servers in the right sidebar on usage and history tabs, reusing the shared destination rows.
  One server is a summary; several servers switch billing directly from the visible list.
  Keep one Add resources action at the right of the page header; the sidebar
  selects the server being inspected. Plans keeps the shared Cloud space picker beside
  Add resources in that header, with the normal destination summary and searchable menu.
  Billing tabs occupy their own full-width row underneath, with an uninterrupted divider.
  Keep adjacent links at the shared tab height so the divider meets the active underline on a single row.
  With one Cloud space, show its summary without a redundant menu. With one or two preset choices, show the saved subscription and capacity in
  the standard 340px right column when the container has room; stack it first on smaller
  screens. Keep a single priced offer at a maximum of 26rem, shrinking to the available
  width on small screens. Complimentary-plan support guidance belongs inside the saved-plan
  summary; dialogs without that summary retain their inline guidance. Wider comparisons and
  Custom keep the compact summary below the tabs. Use the
  picker's displayed choices for this layout too; an inactive subscription uses a short
  inline notice. New purchases use the plan introduction
  as the page title and description. Keep Plans / Custom in the purchase header and
  Back to billing in the same header, using matching 40px controls. Purchasing does not require a server-name field.
  An existing server without a plan keeps the server selector, including when every
  server is unpaid. Only an explicit new-server purchase replaces it with Back to billing.
  Do not repeat the introduction below the page heading. Default to relevant upgrades; offer
  Other plans deliberately for lower-cost changes and Custom when no larger preset fits.
  Do not call today's catalog terms the current plan if they differ from the saved purchase,
  or offer a preset that would shrink an existing disk. New-server purchases have their own
  explicit entry and never inherit the selected server's billing scope.
  A preset chosen on the public Pricing page continues to Cloud checkout after
  sign-in without a second plan-selection click. Validate it against the live
  catalog and bind the retry identity to the authenticated organization. Reloads
  reuse the same server and payment; generic Get server links remain browse-only.
  Unscoped billing opens an existing subscription directly; never
  auto-switch a checkout return or an explicitly selected server. New customers see
  Cloud plans and Pay as you go with a direct Payments & invoices link in the existing
  tab row, so unfinished purchases remain recoverable before the first subscription.
  Reuse the same purchase controls in server setup and destination dialogs. Switching
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
  Keep Pending payments inside Payments & invoices, including for unpaid servers, with
  a yellow pending count on that tab. Share one scoped read with the recovery list, refresh
  on return from hosted checkout, and remove counts only after confirmed cancellation.
  Cloud lists unfinished payments across the organization's servers. Connected installations
  use the same Cloud inventory, filtered to a selected server when requested, without
  creating local execution links. Preserve local aliases for explicitly linked servers
  and clear payment state when the connected Cloud account changes. Reuse the same compact recovery list in
  Payments and in the unfinished-checkout dialog. Show saved offer terms and the server
  name, with Resume and provider-supported cancellation. Never present a pending or
  unknown cancellation as complete. After confirmed cancellation, offer another plan
  and reuse the existing delete confirmation for an unused, unpaid server.
  Distinguish failed cancellation checks (Refresh) from payments without provider-supported
  cancellation (complete the payment or wait for expiry). Show the support link once;
  neither condition may clear a payable checkout or allow a competing subscription.
- Monthly Cloud spaces show purchased resources, paid-through coverage and measured CPU time;
  they have no compute-credit donut, exhaustion alert or credit top-up action. Keep optional
  managed proxy transfer and retained-storage charges distinct from compute coverage, with
  details in a compact disclosure. Put Monthly coverage after the main billing overview and
  usage guide, so plan capacity and usage lead the page. Existing metered subscriptions retain their credit view.
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

Saved Cloud server links remain visible after sign-out so local project destinations do not
disappear. Mark them **Cloud sign-in required**, with a direct action through the existing
Cloud connection flow. Distinguish a different owning account from temporary Cloud failure.
While Cloud authority is unverified, do not mount live SSH/networking/usage controls or offer
plan changes, provisioning, edits or deletion. Reconnect refreshes the same link; it must not
create another server. A missing control route on an older Cloud API shows **Control unavailable**
with upgrade guidance; structured resource and permission 404s retain their original meaning.

Cloud navigation and the page heading use **Cloud spaces**. Each independently purchased allocation
is presented as a **Cloud space**: show measured CPU, memory and storage usage
and assigned projects in Overview, with lifecycle progress in Activity. Put the compact Cloud space
dropdown in the 340px right column above plan capacity. The picker shows the selected name,
plan and project count, with a compact status ring at the right of the selected row instead
of a separate badge below. Keep a readable status label for assistive technology and hover.
Use the shared cloud icon for managed destinations and Cloud spaces navigation. Activity
explains setup, capacity changes and recovery, with Cloud space wording in its progress logs.
Other choices appear only when opened. On narrow screens,
place the picker before usage and keep plan capacity below the main content. Spaces are deployment destinations using existing purchased workspace identities,
not organization workspaces or combined capacity. Keep resource and billing actions on the existing billing flow.

Cloud spaces uses the read-only provider metrics stream through Openship's authenticated monitor
endpoint. Title the card Resource usage, and show Live only after a valid sample; pause hidden pages and cancel subscriptions when
the space, account or tab changes. Retain and label the last reading on disconnect with Retry.
Recent charts contain at most 60 samples from the open page, not billed usage or historical analytics.
Provider usage frames can omit individual metrics. Resolve CPU, memory and storage independently
by measurement time from recent live readings and the host snapshot; a partial frame must not
erase measured storage. Keep each memory/storage group together, show the measurement time when a row uses an
older sample, and leave unknown values and chart gaps unknown rather than substituting capacity or zero.
Project storage inventory uses the existing snapshot request and is not scanned on every live tick.
Cloud spaces and Billing reuse the shared destination picker rows, project counts and catalog plan names.
Keep instant resource readings and project storage on Cloud spaces. Billing retains subscription,
payment, billing-period usage and entitlement counters, with selected-space links instead of another
host-usage snapshot. Show actual allocated capacity on Cloud spaces; pending plan changes remain
in Billing's existing confirmation and resize flow.
Unfinished Cloud setup shows a calm Cloud space notice and does not subscribe to live metrics.

Managed resources do not expose host terminals, SSH, provider networking, Runtime API credentials,
listener inspection or manual process controls, including when opened through Desktop or an old
server link. Project logs and service consoles remain available from their project. Connected
self-hosted servers retain host administration. Failed reads show a retry and unknown usage;
never substitute zero usage or an empty project list for an unavailable observation.

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
Routing rules have visible sections for rewrites, redirects, response headers, and
URL behavior. Group proxy settings into uploads, timeouts, response buffering,
compression, headers/protocol, and upstream TLS. Use human labels and shared filled
controls; keep directive names in each group's Technical details disclosure.
Trailing slashes have three choices: automatic, add, and remove. Live edge inspection
is an explicit refresh, not an automatic SSH request when the page opens. Show
proxy overrides only for targets that apply them, preserving stored values when
editing other routing rules.

Project and service route saves share the same inline preparation and HTTPS progress viewer.
The first exposed route retains proxy takeover consent and completes domain checks after edge
setup. New custom hostnames on an existing edge use the existing project routing/HTTPS check;
DNS-01 setup stays explicit. Reordering/removing routes does not request another certificate.
Refresh canonical route and certificate state after any preparation outcome.
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
The global notice is compact and has no drop shadow. Brief transport interruptions
that recover within 1.5 seconds do not flash it; a slow individual request is not
evidence that the API is disconnected. Its retry reads API liveness only, never
repeats a failed mutation. Any newer HTTP response clears obsolete connection
failures, while the original request still reports its own error to its caller.

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
Project rows and deployment history share `ProjectStackIcon` after the catalog-logo and
favicon choices. A missing or unrecognized framework uses the neutral application icon;
only a declared static framework uses HTML5. Service-group deployments with no app framework
use `layers`, based on their saved execution mode. Adding services to a recognized app must
not replace its framework artwork.

Migration retries reuse the shared destination picker after a fresh scan, even when opened
from an existing run. Keep loading, fetch errors and empty inventory distinct, and preserve
the selected destination's validation and transfer review before enabling Migrate.

Catalog brand artwork is bundled in both dashboard and website public assets and mapped in
the shared `AppLogo` renderer. Preserve upstream attribution and keep setup behavior in
catalog definitions, rather than adding app-specific dashboard branches.

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

## Mail webmail recovery

Cloud's Emails entry connects an existing IMAP/SMTP backend through the standard
webmail app installer. Keep its client card beside a compact Managed email / Coming
soon notice. Cloud mail entry points must not mount local server setup, registry or
administration requests. Desktop and self-hosted instances retain the normal mail
console and setup flow. Navigation remains Emails across these modes.

When a mail registration has lost its webmail link, the Deploy webmail screen
shows existing catalog apps that already use that mail hostname on the mail
server. Suggestions are read-only and require an explicit selection before
Reconnect and deploy. Reuse the selected project's credentials, service and
volume identities. Keep its server and hostname fixed during recovery, and show
that constraint inline. Never create a second app or grant hostname ownership
just because an app looks like webmail. A failed status read shows the shared
error and Retry state; a changed link requires refreshing before another attempt.

## Cloud authorization

Desktop, self-hosted and CLI Cloud consent share a compact identity panel. Show
the signed-in account (name, email and avatar) and the actual active organization.
Use explicit Switch controls; expand organization choices inline without leaving
the request. Never substitute the first organization when the session has none.
Loading or failed organization reads show a skeleton or retry beside the identity
and block authorization. Account switching signs out before continuing to login;
organization switching reloads the same request after the server confirms the
session change. Preserve callback, device mode, state and PKCE parameters, and
require another explicit Authorize click after either switch.

In the deployment wizard, Include www keeps the two hostnames as normal public
endpoints. On Cloud and self-hosted destinations, adding the sibling keeps the typed
hostname primary and redirects the other with HTTP 301. A filled
Domain behavior selector offers either hostname as primary or Serve both. Derive
that selection from the endpoint redirect fields; do not persist a parallel mode.
Keep existing choices until explicitly edited. Show the redirect target in the
collapsed domain row and hide app port/static-path fields for redirect domains.
Choose a serving hostname for primary metadata. Offer the same choices for Cloud
projects opened in Desktop and for projects managed directly in Cloud. Provider
implementation details belong in engineering documentation.

Deploy-domain autosaves preserve edit order, including switching to None. Queued
writes are discarded when the account or organization changes. Reuse the shared
keyed mutex and API scope generation. Project route edits share the existing
project runtime lock across preparation, persistence and live application, keeping
a primary-direction change together across concurrent requests.

## Personal appearance

Keep the original Appearance card and its four immediate theme switches in Settings → General. Its Customize button opens the editor inline at `/settings?tab=general&view=appearance`, keeping General selected in desktop and mobile navigation. Provide Back to General; do not add a dedicated Appearance tab. Inside Customize, use compact labeled icon buttons for Light, Dim, Dark and System instead of large preview cards; keep New theme alongside the selector and preserve the original cards in General. The editor owns personal themes, token editing, typography and portable JSON import/export. The registry and built-in values in `packages/core/src/appearance.ts` and `appearance-defaults.json` are authoritative. Regenerate `apps/dashboard/src/styles/theme-tokens.css` with `node scripts/generate-theme-tokens.mjs`; `theme.css` retains utilities and semantic aliases. Do not duplicate palettes in components. Preset thumbnails use the immutable built-in values; previews and their bridge aliases resolve within `[data-appearance-preview]`.

Use one versioned format across dashboard, API, SDK, CLI and native operations. Save is user-scoped and explicit; a draft updates CSS variables live, while failures preserve the draft. Read failures must not become editable server defaults. Cache by API origin and authenticated user, discard late responses across account switches, and paint validated cached variables before hydration. The editor's recovery controls use the immutable base palette and system font so users can always reset an unreadable theme. WOFF2 assets travel in JSON; do not load arbitrary remote CSS or fonts from imported themes. Terminals subscribe to the shared appearance event, update their existing renderer and refit without reconnecting the PTY.

## Managed public ingress

Cloudflare Tunnel setup belongs in a self-hosted server's existing **Security** tab.
Reuse the shared credential editor inline; send saved credential IDs to ingress operations.
Use compact status, a skeleton during reads, and `ConnectionNotice` for unavailable
status so a failed request cannot look like an empty setup. Poll only pending work
quickly, and stop polling idle connection cards.

Domain cards keep their existing external-ingress row with an inline **Manage** action.
Show the persisted tunnel/DNS/Access phase and retry errors there. Server defaults apply
only to new custom domains and must be explicit in the deployment and Add domain forms.
Existing hostnames keep their Access choice when server defaults change. Close or reset
private dialogs on account/organization switches, discard late results, and guard
backdrop, Escape and close buttons while a write is in flight.

The project Apps & Services view keeps runtime-role configuration and live role replicas
available when the primary app is represented by a service row. The existing role editor
reads support from the API; do not add a duplicate primary application card. Service-only
changes retain the web process and roles, while the toolbar wraps on narrow screens.

Webhook delivery rows show a short, localized explanation below the repository when change analysis records a decision. Reuse the existing feed; keep unknown reason codes out of user-facing text.

## Topology scaling

Node Overview offers a compact Scale action that opens the existing inspector.
Keep replica controls directly accessible. For ordinary Docker services, lead with
the existing Clone action and identify it as an independent copy, not synchronized
replication. CPU, memory, swap and moving the environment belong in a collapsed
Advanced section. Use short scope hints and the shared swap switch; retain resource
validation, pending-change review and destination capability checks.
Application replica changes show the observed and requested counts in a review
before calling the existing configuration release API. Preserve stale-release
preconditions and action locks. Unsupported Kubernetes Compose workloads, storage,
and Cloud destinations show their capability reason; do not advertise application
copies as synchronized replicas. An existing compute cluster can open the shared
runtime setup inline, preserving the workload draft. Embedded setup omits runtime
removal and unrelated navigation; continuation rechecks readiness and does not
deploy an application.

Managed database nodes have Overview, Scale, and Details views.
Replicated database data members are expanded in the project overview by default,
with primary/replica roles, readiness, servers, and replication arrows. Keep a
compact toggle for large graphs. A transparent logical database header retains
settings and writer/reader bindings; individual pods remain inspection-only.
Never invent members from the requested count or a primary from pod ordinals.
Sentinel voters are counted separately and remain inspectable in Instances.
Single-instance databases stay as one card. Scale shows the primary/replica or shard
layout, observed readiness and timestamp, and reviews changes against the saved
sequence. PostgreSQL presents a read-replica count;
Redis replication and sharding remain distinct. Connection fields allow explicit
writer and reader bindings, explain application-side selection, and keep secrets
masked. Use semantic surfaces and existing controls, with progress from saved
operations. Account, workspace and instance changes reset private drafts/reviews.

Fine-grained token capability hints describe the enforced operation scope. Deployment trigger access does not promise cancellation, rollback, or deletion; those keep their project admin requirement.

Monorepo imports start with an explicit **Choose apps** step. Detection supplies candidates;
CLI tools, mobile apps and packages are never enabled just because they have a port.
Show selected app cards only, with **Change selection** followed by **Add more** on the
right of the section header. **Add more** opens the repository folder picker. Folder
selection reuses repository browsing and detection, while
commands, environment and framework edits reuse the existing app form. Rescans retain
user choices and manually added folders. Keep each route on its owning app. The sidebar
shows at most three domain rows, a total count and **View all**; the shared domain editor
uses an app selector and a public-access toggle. Changing wizard settings takes effect
when saved or deployed, according to the existing wizard action.

Service detail headers keep Open, Redeploy and image-update actions in the shared More
menu. Reuse the existing runtime-update actions and operation guards; Settings remains the
place for the full lifecycle controls. Volume cards must allow their action menu to extend
outside the card instead of clipping it with `overflow-hidden`.

Service environment saves review inherited project values and direct Compose references
before offering a shared update. List the affected services by name, allow per-variable
selection and keep **Only this service** explicit. Derive the review from the existing
environment resolver; equal names or literals do not establish a shared source. Keep
secret values out of the review. Save shared and local edits together, reject stale
reviews, and link to each affected service's existing environment apply/redeploy flow.
Explain that these settings live in Openship and do not edit repository files.

### Adding project services

- The topology resource chooser has a compact header with Close and a padded, scrollable body. Fit the chooser to its options within the canvas height; keep resource forms in the full-height inspector.
- Services and Topology share the same Add service modal. Its compact source selector offers Catalog, From repository, Custom image, and Connect existing; a searchable category dropdown replaces a permanent catalog sidebar.
- Repository builds use the current project's repository and branch. Browse folders and files through the shared repository path browser; manual paths remain available if browsing fails. Show build context and Dockerfile paths relative to the repository root, with inline validation and a save-then-deploy hint.
- Reuse the existing service create fields and deployment action. Do not label every self-hosted destination “Local Docker” or add a second build pipeline for this form.
