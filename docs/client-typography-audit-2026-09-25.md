# Client typography and control audit — 2026-09-25

Scope: the dashboard, including Cloud and email administration, the desktop shell, and the shared UI package. The separate marketing site and mail client are outside this pass. Findings describe the current working tree on `feat/client-icon-system`.

## Completed

- Source Repository uses the existing `text-sm` token (14px) for body text, labels, descriptions, and actions, and `text-xs` (13px) for secondary metadata. Its repository identity uses `text-base`. There are no remaining literal font sizes in `GitSettings.tsx`.
- Auto deploy reuses the **exact Demo mode control**, `Toggle` from `ServerSideSwitch.jsx`. Its track, thumb, sizes, colors, and focus treatment come from that existing component. No new checkbox or switch design was introduced. The separate `Switch.tsx` and `Checkbox.tsx` were not changed by this pass.
- The Auto deploy control stays disabled while its request is pending, with inline loading feedback. Failed requests retain the saved state and show the API error.
- Repository actions and commit metadata wrap on narrow screens. Long repository and branch names truncate; section descriptions wrap instead of being squeezed beside the action button.
- The commits icon now uses the existing warning color tokens.

## Confirmed remaining text issues

These are source-level findings in visible UI text. They remain for a later, scoped cleanup; this pass fixes Source Repository.

| Area | Finding | Representative location |
| --- | --- | --- |
| Domains and routing | 10–12px labels, explanations, actions, and status details; some also reduce the muted text token with additional opacity. | [DomainSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/DomainSettings.tsx#L2187) |
| Build settings | Section descriptions and setting labels remain 12px. | [BuildSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/BuildSettings.tsx#L56) |
| Project environment | 12px introduction, 11px linked-source explanation, and 10px linked badge. | [EnvVarsEditor.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/EnvVarsEditor.tsx#L251) |
| Advanced, resources, and storage | Repeated 12px section descriptions, field labels, configuration values, and help text. | [AdvancedSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/AdvancedSettings.tsx#L744), [StorageSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/StorageSettings.tsx#L357), [ResourceSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/ResourceSettings.tsx) |
| Incoming webhooks | 10px auth badge and 11px target IDs and field labels. | [IncomingWebhooks.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/IncomingWebhooks.tsx#L194) |
| Snapshot retention | The shared setting row still uses a literal 12px description. | [InfoCard.tsx](../apps/dashboard/src/components/settings/InfoCard.tsx#L43) |
| Deploy and migration | 10–11px badges, repository hints, section labels, and migration details. | [DeployTargetStep.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep.tsx#L127), [ServerMigrationWizard.tsx](../apps/dashboard/src/components/migration/ServerMigrationWizard.tsx#L3445) |
| Server settings | Rate-limit descriptions/actions and several connection/port details use 10–12px text. | [rate-limit-settings.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/rate-limit-settings.tsx#L258), [connection-banner.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/connection-banner.tsx) |
| Jobs and backups | Job actions and identifiers, backup state badges, and schedule details use 10–12px text. | [jobs/page.tsx](../apps/dashboard/src/app/(dashboard)/jobs/page.tsx#L208), [BackupSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/BackupSettings.tsx#L760) |
| Sidebar | 11px section headings, 10–12px account metadata and organization-switcher text, with further opacity reduction in some cases. | [sidebar.tsx](../apps/dashboard/src/components/sidebar.tsx#L350) |
| Topology | A narrow-container CSS rule forces the pending notice to 11px despite the shared text token. | [topology.css](../apps/dashboard/src/components/topology/topology.css#L150) |
| Email administration | Health, port, and delivery metadata still use 11px text. | [health-tab.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/health-tab.tsx#L389) |
| Onboarding | Its separate CSS defines several 10.5–12.5px labels and descriptions. | [onboarding.css](../apps/dashboard/src/app/(onboarding)/onboarding/onboarding.css#L125) |
| Standalone windows and errors | Desktop update notes/status and global error details/links have separate 11–12.5px styles. They do not inherit the dashboard typography token. | [update-window.ts](../apps/desktop/src/main/update-window.ts#L53), [global-error.tsx](../apps/dashboard/src/app/global-error.tsx#L42) |

## Remaining control inconsistencies

These controls use the page background for their thumb even while unchecked. On dim surfaces that produces the same dark, low-contrast indicator pattern. Keep the approved Demo mode appearance when addressing them; do not introduce another design.

| Control | Location | Other observed drift |
| --- | --- | --- |
| Incoming webhook enabled | [IncomingWebhooks.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/IncomingWebhooks.tsx#L208) | Separate inline implementation. |
| Retain snapshots | [RollbackRetentionCards.tsx](../apps/dashboard/src/components/rollback/RollbackRetentionCards.tsx#L108) | Separate inline implementation and pending rendering. |
| Catalog app boolean fields | [AppSettingsForm.tsx](../apps/dashboard/src/components/app-settings/AppSettingsForm.tsx#L239) | No programmatic label for the switch; physical translation does not mirror in RTL. |
| Job enabled in list | [jobs/page.tsx](../apps/dashboard/src/app/(dashboard)/jobs/page.tsx#L212) | No exposed toggle state; physical translation does not mirror in RTL. |
| Job enabled in detail | [jobs/[key]/page.tsx](../apps/dashboard/src/app/(dashboard)/jobs/[key]/page.tsx#L136) | Same duplicate as the list. |
| Include www, DNS challenge, external ingress | [DomainSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/DomainSettings.tsx#L2191) | Three copies; inconsistent accessible state/label handling and no mirrored thumb translation. |
| Expose service publicly | [RoutingSettingsCard.tsx](../apps/dashboard/src/components/routing/RoutingSettingsCard.tsx#L329) | Separate dimensions and information-color track; no programmatic label or toggle state. |
| Other shared switch | [Switch.tsx](../apps/dashboard/src/components/ui/Switch.tsx#L82) | Still uses `bg-background` for the unchecked thumb. Used in public endpoints, access scopes, scaling fields, audit filters, port forwarding, migration, settings rows, and modal options. Left unchanged in this pass. |

The existing Demo mode `Toggle` itself uses physical `left` and positive translation rather than logical positioning. That is a separate RTL consistency finding, not a reason to redesign its appearance. No new defect was confirmed in the square `Checkbox` component.

## Verification

Browser verification used the real components, project context, API client, and Tailwind/theme CSS with intercepted API responses. No live project settings were changed. Eighteen scenarios cover:

- Exact comparison with the rendered Demo mode toggle, checked and unchecked, in light, dim, and dark themes.
- Auto deploy loading, disabled behavior, duplicate-click prevention, success, API failure, and keyboard interaction; a project without a public endpoint can still turn off an existing enabled setting.
- Narrow and wide Source pages, long names, Arabic layout, missing Git installation, empty commits, missing repository, and clone-token save/replace/cancel/clear.
- The related service-header request: image/build details live in Overview, full values copy correctly, and image-only, build-only, long-reference, and missing-source cases render correctly.

The 23 existing Source skeleton and service Overview tests and the dashboard TypeScript check pass.

## Static inventory

The inventory below records literal font declarations below 13px across client `.tsx`, `.jsx`, `.ts`, `.js`, and `.css` files, excluding tests and declaration files. `rem`/`em` values, if present, are estimated against a 16px base. Chart ticks, SVG illustration labels, compact badges, dormant components, and responsive overrides are included as **candidates**, not automatically classified as bugs. Runtime visibility and intended use must be checked before changing each candidate. For example, `HomeWelcome` has SVG illustration labels, and chart-axis text belongs to chart layout rather than body typography.

The shared `text-xs` token already resolves to 13px. The remaining explicit sizes bypass that token; changing it again will not fix these declarations. Literal sizes of 13px and above can also bypass tokens, but are outside this undersized-text inventory.

Scanned **822 files**. Found **692 declarations in 179 files**. These counts describe code occurrences, not the number of verified UI bugs.

| Area | Files | Declarations |
| --- | ---: | ---: |
| Deploy, import, and migration | 23 | 97 |
| Desktop updater | 1 | 3 |
| Email administration | 15 | 48 |
| Jobs and backups | 9 | 63 |
| Monitoring, topology, home, and billing | 23 | 58 |
| Project settings and routing | 39 | 220 |
| Servers and infrastructure | 18 | 65 |
| Settings, permissions, and updates | 26 | 74 |
| Shell and other shared UI | 24 | 53 |
| Sign-in and onboarding | 1 | 11 |

| File (first occurrence) | Declarations | Literal sizes |
| --- | ---: | --- |
| [dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/CloudWaitlistModal.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/[slug]/components/CloudWaitlistModal.tsx#L69) | 1 | 11px |
| [dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep.tsx#L127) | 10 | 10px, 11px |
| [dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/RollbackBackupPanel.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/[slug]/components/RollbackBackupPanel.tsx#L138) | 3 | 12px |
| [dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/ServerRuntimePicker.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/[slug]/components/ServerRuntimePicker.tsx#L119) | 2 | 10px, 12px |
| [dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/Sidebar.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/[slug]/components/Sidebar.tsx#L137) | 1 | 10px |
| [dashboard/app/(dashboard)/(deployment)/deploy/mail/page.tsx](../apps/dashboard/src/app/(dashboard)/(deployment)/deploy/mail/page.tsx#L295) | 1 | 11px |
| [dashboard/app/(dashboard)/apps/new/[appId]/page.tsx](../apps/dashboard/src/app/(dashboard)/apps/new/[appId]/page.tsx#L1473) | 2 | 10px, 11px |
| [dashboard/app/(dashboard)/audit/_components/AuditLog.tsx](../apps/dashboard/src/app/(dashboard)/audit/_components/AuditLog.tsx#L184) | 3 | 10px |
| [dashboard/app/(dashboard)/backups/[id]/page.tsx](../apps/dashboard/src/app/(dashboard)/backups/[id]/page.tsx#L127) | 10 | 10px, 11px, 12px |
| [dashboard/app/(dashboard)/backups/page.tsx](../apps/dashboard/src/app/(dashboard)/backups/page.tsx#L189) | 5 | 11px |
| [dashboard/app/(dashboard)/deployments/components/DeploymentCard.tsx](../apps/dashboard/src/app/(dashboard)/deployments/components/DeploymentCard.tsx#L184) | 6 | 10px, 11px |
| [dashboard/app/(dashboard)/deployments/components/DeploymentHeader.tsx](../apps/dashboard/src/app/(dashboard)/deployments/components/DeploymentHeader.tsx#L39) | 3 | 10px |
| [dashboard/app/(dashboard)/deployments/components/DeploymentsFilters.tsx](../apps/dashboard/src/app/(dashboard)/deployments/components/DeploymentsFilters.tsx#L103) | 1 | 12px |
| [dashboard/app/(dashboard)/dev/issues/IssuesPreview.tsx](../apps/dashboard/src/app/(dashboard)/dev/issues/IssuesPreview.tsx#L110) | 2 | 12px |
| [dashboard/app/(dashboard)/emails/_components/admin/SendTestMailModal.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/SendTestMailModal.tsx#L182) | 4 | 11.5px, 12.5px |
| [dashboard/app/(dashboard)/emails/_components/admin/_shared/data-table.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/_shared/data-table.tsx#L93) | 1 | 11px |
| [dashboard/app/(dashboard)/emails/_components/admin/_shared/logs-drawer.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/_shared/logs-drawer.tsx#L93) | 2 | 11.5px |
| [dashboard/app/(dashboard)/emails/_components/admin/_shared/status-pill.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/_shared/status-pill.tsx#L50) | 1 | 11px |
| [dashboard/app/(dashboard)/emails/_components/admin/advanced-tab.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/advanced-tab.tsx#L281) | 2 | 11px, 11.5px |
| [dashboard/app/(dashboard)/emails/_components/admin/dns-tab.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/dns-tab.tsx#L297) | 4 | 10px, 11px, 11.5px |
| [dashboard/app/(dashboard)/emails/_components/admin/engine-banner.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/engine-banner.tsx#L81) | 1 | 12px |
| [dashboard/app/(dashboard)/emails/_components/admin/health-tab.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/health-tab.tsx#L185) | 18 | 10px, 11px, 11.5px, 12px |
| [dashboard/app/(dashboard)/emails/_components/admin/mail-restore-modal.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/mail-restore-modal.tsx#L318) | 1 | 11px |
| [dashboard/app/(dashboard)/emails/_components/admin/overview-tab.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/overview-tab.tsx#L147) | 2 | 10.5px, 11px |
| [dashboard/app/(dashboard)/emails/_components/admin/sending-tab.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/sending-tab.tsx#L563) | 3 | 10px, 11px |
| [dashboard/app/(dashboard)/emails/_components/admin/welcome-modal.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/admin/welcome-modal.tsx#L67) | 3 | 12.5px |
| [dashboard/app/(dashboard)/emails/_components/ptr-hold-banner.tsx](../apps/dashboard/src/app/(dashboard)/emails/_components/ptr-hold-banner.tsx#L127) | 3 | 11px, 12px |
| [dashboard/app/(dashboard)/issues/IssuesView.tsx](../apps/dashboard/src/app/(dashboard)/issues/IssuesView.tsx#L316) | 5 | 11px, 12px |
| [dashboard/app/(dashboard)/jobs/[key]/page.tsx](../apps/dashboard/src/app/(dashboard)/jobs/[key]/page.tsx#L118) | 10 | 10px, 11px, 12px |
| [dashboard/app/(dashboard)/jobs/page.tsx](../apps/dashboard/src/app/(dashboard)/jobs/page.tsx#L189) | 22 | 10px, 12px |
| [dashboard/app/(dashboard)/library/components/LibrarySidebar.tsx](../apps/dashboard/src/app/(dashboard)/library/components/LibrarySidebar.tsx#L320) | 2 | 10px |
| [dashboard/app/(dashboard)/library/components/RepositoryList.tsx](../apps/dashboard/src/app/(dashboard)/library/components/RepositoryList.tsx#L339) | 2 | 10px |
| [dashboard/app/(dashboard)/projects/[id]/[[...slug]]/page.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/[[...slug]]/page.tsx#L369) | 1 | 10px |
| [dashboard/app/(dashboard)/projects/[id]/components/AdvancedSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/AdvancedSettings.tsx#L80) | 15 | 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/AppSource.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/AppSource.tsx#L195) | 1 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/BackupSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/BackupSettings.tsx#L400) | 5 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/BuildSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/BuildSettings.tsx#L56) | 2 | 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/ConnectedServicesCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/ConnectedServicesCard.tsx#L59) | 1 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/ConnectionCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/ConnectionCard.tsx#L262) | 2 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/DeletionModal.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/DeletionModal.tsx#L176) | 3 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/Deployments.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/Deployments.tsx#L216) | 8 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/DomainSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/DomainSettings.tsx#L763) | 50 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/DraftProjectView.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/DraftProjectView.tsx#L205) | 2 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/EnvVarsEditor.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/EnvVarsEditor.tsx#L251) | 4 | 10px, 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/HealthTab.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/HealthTab.tsx#L204) | 7 | 10px, 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/IncomingWebhooks.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/IncomingWebhooks.tsx#L194) | 4 | 10px, 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/OverviewTab.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/OverviewTab.tsx#L308) | 12 | 9px, 10px, 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/ProjectSidebar.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/ProjectSidebar.tsx#L105) | 2 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/ReleaseImageSourceSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/ReleaseImageSourceSettings.tsx#L180) | 2 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/ResourceSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/ResourceSettings.tsx#L72) | 14 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/RouteRules.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/RouteRules.tsx#L211) | 6 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/RoutingConfigCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/RoutingConfigCard.tsx#L110) | 2 | 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/RoutingUnsyncedCallout.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/RoutingUnsyncedCallout.tsx#L34) | 1 | 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/SleepModeSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/SleepModeSettings.tsx#L75) | 1 | 9px |
| [dashboard/app/(dashboard)/projects/[id]/components/StorageSettings.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/StorageSettings.tsx#L63) | 12 | 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/UseInProjectModal.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/UseInProjectModal.tsx#L39) | 10 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/UsedByCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/UsedByCard.tsx#L52) | 1 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/WebhookDeliveries.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/WebhookDeliveries.tsx#L123) | 3 | 10px, 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/general/TrafficChart.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/general/TrafficChart.tsx#L49) | 3 | 9px, 10px |
| [dashboard/app/(dashboard)/projects/[id]/components/logs/ServerLogs.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/logs/ServerLogs.tsx#L295) | 4 | 11px |
| [dashboard/app/(dashboard)/projects/[id]/components/services/AddServiceModal.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/services/AddServiceModal.tsx#L670) | 9 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/[id]/components/services/LinkedAppsCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/[id]/components/services/LinkedAppsCard.tsx#L99) | 2 | 11px, 12px |
| [dashboard/app/(dashboard)/projects/components/ProjectCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/components/ProjectCard.tsx#L146) | 3 | 10px |
| [dashboard/app/(dashboard)/projects/components/ProjectGridCard.tsx](../apps/dashboard/src/app/(dashboard)/projects/components/ProjectGridCard.tsx#L78) | 3 | 10px |
| [dashboard/app/(dashboard)/servers/[serverId]/_components/components-tab.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/components-tab.tsx#L286) | 2 | 10px, 11px |
| [dashboard/app/(dashboard)/servers/[serverId]/_components/connection-banner.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/connection-banner.tsx#L233) | 10 | 11px, 12px |
| [dashboard/app/(dashboard)/servers/[serverId]/_components/exposed-ports-card.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/exposed-ports-card.tsx#L55) | 10 | 11px, 12px |
| [dashboard/app/(dashboard)/servers/[serverId]/_components/module-updates.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/module-updates.tsx#L69) | 1 | 10px |
| [dashboard/app/(dashboard)/servers/[serverId]/_components/overview-tab.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/overview-tab.tsx#L214) | 1 | 11px |
| [dashboard/app/(dashboard)/servers/[serverId]/_components/rate-limit-settings.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/_components/rate-limit-settings.tsx#L258) | 19 | 12px |
| [dashboard/app/(dashboard)/servers/[serverId]/page.tsx](../apps/dashboard/src/app/(dashboard)/servers/[serverId]/page.tsx#L625) | 2 | 11px |
| [dashboard/app/(dashboard)/servers/_components/coming-soon-panel.tsx](../apps/dashboard/src/app/(dashboard)/servers/_components/coming-soon-panel.tsx#L38) | 1 | 11px |
| [dashboard/app/(dashboard)/servers/new/_components/results-panel.tsx](../apps/dashboard/src/app/(dashboard)/servers/new/_components/results-panel.tsx#L57) | 1 | 11px |
| [dashboard/app/(dashboard)/servers/page.tsx](../apps/dashboard/src/app/(dashboard)/servers/page.tsx#L540) | 1 | 10px |
| [dashboard/app/(dashboard)/settings/_components/CloneCredentials.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/CloneCredentials.tsx#L215) | 5 | 11px, 12px |
| [dashboard/app/(dashboard)/settings/_components/Credentials.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/Credentials.tsx#L175) | 2 | 10px |
| [dashboard/app/(dashboard)/settings/_components/DataTransferTab.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/DataTransferTab.tsx#L200) | 3 | 10px, 11px |
| [dashboard/app/(dashboard)/settings/_components/DeployDefaults.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/DeployDefaults.tsx#L200) | 1 | 11px |
| [dashboard/app/(dashboard)/settings/_components/GitHubConnection.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/GitHubConnection.tsx#L344) | 3 | 10px, 10.5px, 11px |
| [dashboard/app/(dashboard)/settings/_components/GitHubSources.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/GitHubSources.tsx#L304) | 6 | 10px, 11px |
| [dashboard/app/(dashboard)/settings/_components/InfrastructureTab.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/InfrastructureTab.tsx#L159) | 2 | 12px, 12.5px |
| [dashboard/app/(dashboard)/settings/_components/InviteMemberInline.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/InviteMemberInline.tsx#L403) | 2 | 11px |
| [dashboard/app/(dashboard)/settings/_components/MailModeSetting.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/MailModeSetting.tsx#L138) | 1 | 12.5px |
| [dashboard/app/(dashboard)/settings/_components/McpConnection.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/McpConnection.tsx#L578) | 2 | 10px |
| [dashboard/app/(dashboard)/settings/_components/MigrateModal.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/MigrateModal.tsx#L307) | 6 | 11px |
| [dashboard/app/(dashboard)/settings/_components/ModeChoiceCards.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/ModeChoiceCards.tsx#L68) | 1 | 12.5px |
| [dashboard/app/(dashboard)/settings/_components/NotificationsTab.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/NotificationsTab.tsx#L114) | 3 | 9px, 11px |
| [dashboard/app/(dashboard)/settings/_components/PersonalAccessTokens.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/PersonalAccessTokens.tsx#L316) | 2 | 10px |
| [dashboard/app/(dashboard)/settings/_components/ProductViewSetting.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/ProductViewSetting.tsx#L58) | 1 | 12.5px |
| [dashboard/app/(dashboard)/settings/_components/SettingsToggleRow.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/SettingsToggleRow.tsx#L29) | 1 | 12.5px |
| [dashboard/app/(dashboard)/settings/_components/UntrackedEdgeRoutes.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/UntrackedEdgeRoutes.tsx#L168) | 8 | 11px, 12px |
| [dashboard/app/(dashboard)/settings/_components/UpdatesTab.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/UpdatesTab.tsx#L68) | 1 | 12px |
| [dashboard/app/(dashboard)/settings/_components/WorkspaceManageModal.tsx](../apps/dashboard/src/app/(dashboard)/settings/_components/WorkspaceManageModal.tsx#L239) | 1 | 11px |
| [dashboard/app/(dashboard)/settings/migration/switch-back/page.tsx](../apps/dashboard/src/app/(dashboard)/settings/migration/switch-back/page.tsx#L224) | 1 | 11px |
| [dashboard/app/(onboarding)/onboarding/onboarding.css](../apps/dashboard/src/app/(onboarding)/onboarding/onboarding.css#L125) | 11 | 10.5px, 11px, 12px, 12.5px |
| [dashboard/app/accept-invite/[id]/page.tsx](../apps/dashboard/src/app/accept-invite/[id]/page.tsx#L294) | 1 | 11px |
| [dashboard/app/global-error.tsx](../apps/dashboard/src/app/global-error.tsx#L42) | 2 | 11px, 12px |
| [dashboard/app/mcp/authorize/page.tsx](../apps/dashboard/src/app/mcp/authorize/page.tsx#L410) | 1 | 8px |
| [dashboard/components/api-unavailable.tsx](../apps/dashboard/src/components/api-unavailable.tsx#L63) | 1 | 12px |
| [dashboard/components/apps/AddCustomAppModal.tsx](../apps/dashboard/src/components/apps/AddCustomAppModal.tsx#L104) | 1 | 12px |
| [dashboard/components/apps/AppCatalog.tsx](../apps/dashboard/src/components/apps/AppCatalog.tsx#L232) | 2 | 10px |
| [dashboard/components/apps/BadgeTooltip.tsx](../apps/dashboard/src/components/apps/BadgeTooltip.tsx#L54) | 1 | 11px |
| [dashboard/components/apps/HostingBadge.tsx](../apps/dashboard/src/components/apps/HostingBadge.tsx#L32) | 1 | 10px |
| [dashboard/components/apps/UnverifiedBadge.tsx](../apps/dashboard/src/components/apps/UnverifiedBadge.tsx#L28) | 1 | 10px |
| [dashboard/components/backup/BackupRunCard.tsx](../apps/dashboard/src/components/backup/BackupRunCard.tsx#L70) | 5 | 10px, 11px |
| [dashboard/components/backup/PolicyEditor.tsx](../apps/dashboard/src/components/backup/PolicyEditor.tsx#L795) | 2 | 11px |
| [dashboard/components/backup/RestoreWizard.tsx](../apps/dashboard/src/components/backup/RestoreWizard.tsx#L188) | 4 | 10px, 11px |
| [dashboard/components/billing/BillingTopups.tsx](../apps/dashboard/src/components/billing/BillingTopups.tsx#L143) | 1 | 11px |
| [dashboard/components/billing/PricingCards.tsx](../apps/dashboard/src/components/billing/PricingCards.tsx#L244) | 5 | 11px, 12px |
| [dashboard/components/billing/UsageChart.tsx](../apps/dashboard/src/components/billing/UsageChart.tsx#L23) | 2 | 11px |
| [dashboard/components/deploy/CleanDeployProgress.tsx](../apps/dashboard/src/components/deploy/CleanDeployProgress.tsx#L150) | 10 | 10px, 11px, 11.5px |
| [dashboard/components/deployments/DeployCredentialModal.tsx](../apps/dashboard/src/components/deployments/DeployCredentialModal.tsx#L286) | 1 | 10px |
| [dashboard/components/error-view.tsx](../apps/dashboard/src/components/error-view.tsx#L173) | 1 | 11px |
| [dashboard/components/github/ServerGitHubConnect.tsx](../apps/dashboard/src/components/github/ServerGitHubConnect.tsx#L279) | 2 | 11px, 12px |
| [dashboard/components/import-project/BuildSettings.tsx](../apps/dashboard/src/components/import-project/BuildSettings.tsx#L450) | 1 | 11px |
| [dashboard/components/import-project/ComposePathField.tsx](../apps/dashboard/src/components/import-project/ComposePathField.tsx#L147) | 2 | 11px |
| [dashboard/components/import-project/ComposeServices.tsx](../apps/dashboard/src/components/import-project/ComposeServices.tsx#L333) | 5 | 11px |
| [dashboard/components/import-project/ConfigDiagnostics.tsx](../apps/dashboard/src/components/import-project/ConfigDiagnostics.tsx#L46) | 3 | 11px, 11.5px, 12px |
| [dashboard/components/import-project/Frameworks.tsx](../apps/dashboard/src/components/import-project/Frameworks.tsx#L31) | 2 | 10px |
| [dashboard/components/import-project/MonorepoApps.tsx](../apps/dashboard/src/components/import-project/MonorepoApps.tsx#L104) | 1 | 11px |
| [dashboard/components/import-project/ProjectSettings.tsx](../apps/dashboard/src/components/import-project/ProjectSettings.tsx#L77) | 1 | 10px |
| [dashboard/components/import-project/PromptDetails.tsx](../apps/dashboard/src/components/import-project/PromptDetails.tsx#L88) | 4 | 10px, 11px |
| [dashboard/components/import-project/compose/ServiceRow.tsx](../apps/dashboard/src/components/import-project/compose/ServiceRow.tsx#L61) | 2 | 11px |
| [dashboard/components/infra/ContainerStatusRow.tsx](../apps/dashboard/src/components/infra/ContainerStatusRow.tsx#L52) | 1 | 10px |
| [dashboard/components/infra/InfraFilters.tsx](../apps/dashboard/src/components/infra/InfraFilters.tsx#L71) | 1 | 12px |
| [dashboard/components/infra/InfraFleetCard.tsx](../apps/dashboard/src/components/infra/InfraFleetCard.tsx#L149) | 8 | 11px, 12px, 12.5px |
| [dashboard/components/issues/IssueRow.tsx](../apps/dashboard/src/components/issues/IssueRow.tsx#L57) | 2 | 11px, 12px |
| [dashboard/components/issues/IssueSummary.tsx](../apps/dashboard/src/components/issues/IssueSummary.tsx#L100) | 2 | 11px |
| [dashboard/components/issues/MonitoringHealth.tsx](../apps/dashboard/src/components/issues/MonitoringHealth.tsx#L224) | 5 | 10px, 11px |
| [dashboard/components/jobs/JobForm.tsx](../apps/dashboard/src/components/jobs/JobForm.tsx#L300) | 1 | 10px |
| [dashboard/components/jobs/JobRunLogs.tsx](../apps/dashboard/src/components/jobs/JobRunLogs.tsx#L74) | 4 | 12px |
| [dashboard/components/mail-server-switcher.tsx](../apps/dashboard/src/components/mail-server-switcher.tsx#L93) | 2 | 11px |
| [dashboard/components/migration/ProjectMigrationCard.tsx](../apps/dashboard/src/components/migration/ProjectMigrationCard.tsx#L224) | 9 | 10px, 11px, 12px |
| [dashboard/components/migration/ProjectMigrationHistory.tsx](../apps/dashboard/src/components/migration/ProjectMigrationHistory.tsx#L70) | 1 | 11px |
| [dashboard/components/migration/ServerMigrationWizard.tsx](../apps/dashboard/src/components/migration/ServerMigrationWizard.tsx#L1540) | 27 | 10px, 11px, 12px |
| [dashboard/components/monitoring/CountryDonut.tsx](../apps/dashboard/src/components/monitoring/CountryDonut.tsx#L109) | 1 | 11px |
| [dashboard/components/monitoring/CountryFlag.tsx](../apps/dashboard/src/components/monitoring/CountryFlag.tsx#L30) | 1 | 10px |
| [dashboard/components/monitoring/MonitoringView.tsx](../apps/dashboard/src/components/monitoring/MonitoringView.tsx#L126) | 1 | 11px |
| [dashboard/components/monitoring/ResourceHistoryChart.tsx](../apps/dashboard/src/components/monitoring/ResourceHistoryChart.tsx#L202) | 3 | 11px |
| [dashboard/components/overview/AlertPanel.tsx](../apps/dashboard/src/components/overview/AlertPanel.tsx#L58) | 4 | 11px, 12px |
| [dashboard/components/overview/AttentionCards.tsx](../apps/dashboard/src/components/overview/AttentionCards.tsx#L37) | 1 | 12px |
| [dashboard/components/overview/EmptyState.tsx](../apps/dashboard/src/components/overview/EmptyState.tsx#L81) | 1 | 10px |
| [dashboard/components/overview/HomeWelcome.tsx](../apps/dashboard/src/components/overview/HomeWelcome.tsx#L68) | 2 | 7px, 10px |
| [dashboard/components/overview/OverviewHeroChart.tsx](../apps/dashboard/src/components/overview/OverviewHeroChart.tsx#L327) | 1 | 10px |
| [dashboard/components/permissions/AccessScopeEditor.tsx](../apps/dashboard/src/components/permissions/AccessScopeEditor.tsx#L105) | 2 | 11px |
| [dashboard/components/permissions/AccessScopeSummary.tsx](../apps/dashboard/src/components/permissions/AccessScopeSummary.tsx#L96) | 5 | 10px, 11px |
| [dashboard/components/permissions/AccessTemplateCards.tsx](../apps/dashboard/src/components/permissions/AccessTemplateCards.tsx#L150) | 1 | 10px |
| [dashboard/components/permissions/LevelSwitch.tsx](../apps/dashboard/src/components/permissions/LevelSwitch.tsx#L44) | 2 | 10px, 11px |
| [dashboard/components/permissions/ResourcePicker.tsx](../apps/dashboard/src/components/permissions/ResourcePicker.tsx#L285) | 6 | 10px, 11px |
| [dashboard/components/permissions/SourceAccessModal.tsx](../apps/dashboard/src/components/permissions/SourceAccessModal.tsx#L237) | 3 | 11px |
| [dashboard/components/project-settings/ReadinessSection.tsx](../apps/dashboard/src/components/project-settings/ReadinessSection.tsx#L104) | 4 | 11px |
| [dashboard/components/project-settings/ServerSideSwitch.jsx](../apps/dashboard/src/components/project-settings/ServerSideSwitch.jsx#L41) | 2 | 11px |
| [dashboard/components/rollback/RollbackRetentionCards.tsx](../apps/dashboard/src/components/rollback/RollbackRetentionCards.tsx#L137) | 1 | 11px |
| [dashboard/components/routing/ProxySettingsSection.tsx](../apps/dashboard/src/components/routing/ProxySettingsSection.tsx#L163) | 10 | 10px, 11px |
| [dashboard/components/routing/RoutingConfigEditor.tsx](../apps/dashboard/src/components/routing/RoutingConfigEditor.tsx#L92) | 3 | 11px |
| [dashboard/components/routing/RoutingSettingsCard.tsx](../apps/dashboard/src/components/routing/RoutingSettingsCard.tsx#L404) | 4 | 12px |
| [dashboard/components/scale/ResourceNode.tsx](../apps/dashboard/src/components/scale/ResourceNode.tsx#L110) | 2 | 11px |
| [dashboard/components/scale/ScaleEditor.tsx](../apps/dashboard/src/components/scale/ScaleEditor.tsx#L102) | 1 | 11px |
| [dashboard/components/scale/scale.css](../apps/dashboard/src/components/scale/scale.css#L268) | 1 | 12px |
| [dashboard/components/servers/ServerDeletionModal.tsx](../apps/dashboard/src/components/servers/ServerDeletionModal.tsx#L190) | 2 | 10px, 11px |
| [dashboard/components/servers/clusters/NetworkDetail.tsx](../apps/dashboard/src/components/servers/clusters/NetworkDetail.tsx#L366) | 1 | 10px |
| [dashboard/components/settings/InfoCard.tsx](../apps/dashboard/src/components/settings/InfoCard.tsx#L43) | 1 | 12px |
| [dashboard/components/shared/AutoDnsPanel.tsx](../apps/dashboard/src/components/shared/AutoDnsPanel.tsx#L276) | 6 | 10px, 11px |
| [dashboard/components/shared/CopyCommand.tsx](../apps/dashboard/src/components/shared/CopyCommand.tsx#L54) | 2 | 11px, 12.5px |
| [dashboard/components/shared/DnsRecordsView.tsx](../apps/dashboard/src/components/shared/DnsRecordsView.tsx#L110) | 2 | 11px, 12px |
| [dashboard/components/shared/MachineSettingsModal.tsx](../apps/dashboard/src/components/shared/MachineSettingsModal.tsx#L100) | 1 | 10px |
| [dashboard/components/sidebar.tsx](../apps/dashboard/src/components/sidebar.tsx#L350) | 13 | 10px, 11px, 12px |
| [dashboard/components/terminal/ServerTerminal.tsx](../apps/dashboard/src/components/terminal/ServerTerminal.tsx#L459) | 1 | 11px |
| [dashboard/components/terminal/ServerTerminalTabs.tsx](../apps/dashboard/src/components/terminal/ServerTerminalTabs.tsx#L210) | 2 | 12px |
| [dashboard/components/terminal/ServiceTerminal.tsx](../apps/dashboard/src/components/terminal/ServiceTerminal.tsx#L421) | 1 | 11px |
| [dashboard/components/topology/TopologyCanvas.tsx](../apps/dashboard/src/components/topology/TopologyCanvas.tsx#L79) | 4 | 10px, 11px |
| [dashboard/components/topology/TopologyInspector.tsx](../apps/dashboard/src/components/topology/TopologyInspector.tsx#L67) | 4 | 11px |
| [dashboard/components/topology/TopologyReview.tsx](../apps/dashboard/src/components/topology/TopologyReview.tsx#L162) | 4 | 11px |
| [dashboard/components/topology/TopologyScaling.tsx](../apps/dashboard/src/components/topology/TopologyScaling.tsx#L182) | 5 | 11px |
| [dashboard/components/topology/topology.css](../apps/dashboard/src/components/topology/topology.css#L150) | 1 | 11px |
| [dashboard/components/updates/UpdateCenter.tsx](../apps/dashboard/src/components/updates/UpdateCenter.tsx#L82) | 4 | 11px, 12px, 12.5px |
| [dashboard/hooks/useSystemPrepareModal.tsx](../apps/dashboard/src/hooks/useSystemPrepareModal.tsx#L410) | 2 | 11px |
| [dashboard/lib/chart-theme.ts](../apps/dashboard/src/lib/chart-theme.ts#L39) | 1 | 12px |
| [desktop/main/update-window.ts](../apps/desktop/src/main/update-window.ts#L53) | 3 | 11px, 12px, 12.5px |
