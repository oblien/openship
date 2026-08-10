import { api } from "./client";
import { endpoints } from "./endpoints";
import type { AppManagement, AppSettingGroup, AppTemplate } from "@repo/core";

/** One catalog entry as returned by GET /apps/catalog. */
export interface AppCatalogField {
  key: string;
  service: string;
  label: string;
  help?: string;
  type: "text" | "password";
  default?: string;
  required: boolean;
}

export interface AppCatalogEntry {
  id: string;
  name: string;
  description: string;
  kind: "template" | "flow";
  logo: string;
  category: string;
  tags: string[];
  flowHref?: string;
  /** How the installed app is managed (schema settings / custom href / none). */
  management: AppManagement | null;
  /** Verified trust mark — official open-source image + reviewed pipeline. */
  verified?: boolean;
  /** A per-org user-uploaded app — always unverified; render an "Unverified" chip. */
  custom?: boolean;
  /** Not installable this version — render dimmed + block install. */
  comingSoon?: boolean;
  /** Needs a newer Openship than this instance — render "Requires Openship ≥ X"
   *  + block install (a guided update prompt, distinct from coming-soon). */
  requiresUpdate?: { minVersion?: string };
  /** A newer (engine-gated) version exists; the bundled copy is being served. */
  updateAvailable?: boolean;
  configFields: AppCatalogField[];
}

export type InstallAppResult =
  | { kind: "flow"; flowHref: string }
  | { kind: "template"; projectId: string; slug: string };

/** An org's never-deployed draft of a catalog app — the project an install of the
 *  same name adopts instead of creating a new one. */
export interface AppOpenDraft {
  projectId: string;
  slug: string;
  name: string;
}

/**
 * One endpoint's routing choice, sent WITH the install so the project's services
 * are created with the routing the operator picked. An endpoint the caller omits
 * gets no public route — the server never invents a hostname.
 */
export interface InstallAppRoute {
  service: string;
  port: number;
  /** port = no public route (published host port only). */
  mode: "port" | "free" | "custom";
  /** free: subdomain slug. Omit to take the template's default label. */
  domain?: string;
  /** custom: the hostname you own (required for mode "custom"). */
  customDomain?: string;
}

/** Effective value for one setting field (secrets are never sent back). */
export interface AppSettingValue {
  service: string;
  key: string;
  value: string;
  secret: boolean;
  set: boolean;
}

export interface AppSettingsView {
  appTemplateId: string | null;
  management: AppManagement | null;
  groups: AppSettingGroup[];
  values: AppSettingValue[];
}

export interface AppSettingChange {
  service: string;
  key: string;
  value: string;
}

/** A catalog string that may be plain OR an inline per-locale map (localized in
 *  the catalog JSON). Resolve with `resolveLocalized` from @repo/core. */
export type LocalizedString = string | { [locale: string]: string };

/** One resolved connection value (URL or generated key) for the app Overview. */
export interface AppConnectionOutput {
  id: string;
  label: string;
  help?: string;
  secret: boolean;
  /** Resolved value; "" when not resolvable yet (renders as "—"). */
  value: string;
  /** Catalog-recommended target env-var name for the "Use in a project" handover. */
  envKey?: string;
  /** Source SERVICE (docker alias) this output belongs to — lets the "Use in a
   *  project" modal group outputs by service and pick which service(s) to inject.
   *  null when neither the output's `service` nor its `source` carries one. */
  service: string | null;
  /** Part of the recommended one-click bundle — pre-checked in the handover. */
  recommended?: boolean;
  /** Label for the primary value in the switch (default "Default"); with `variants`. */
  sourceLabel?: LocalizedString;
  /** Resolved alternative forms of the value — the card shows a switch over
   *  `[primary, …variants]` and swaps the shown/copied value. */
  variants?: { id: string; label: LocalizedString; value: string }[];
  /** Layout hint: "half" pairs with the next half-width output on one line. */
  width?: "full" | "half";
  /** "url" → render an Open-in-new-tab action to the right of the value. */
  kind?: "text" | "url";
  /** The value is ALREADY an internal east-west address (`http://<alias>:<port>`),
   *  synthesized for a non-template project — the connect flow injects it verbatim
   *  in internal mode rather than rewriting a public URL. */
  internal?: boolean;
}

/** Opinionated handover guidance (localizable copy). */
export interface AppConnectionGuide {
  intro?: LocalizedString;
  useHint?: LocalizedString;
  defaultMode?: "internal" | "public";
}

export interface AppConnectionView {
  title?: string;
  description?: string;
  outputs: AppConnectionOutput[];
  guide?: AppConnectionGuide;
}

export const appsApi = {
  /** The installable app catalog. */
  catalog: () => api.get<{ data: AppCatalogEntry[] }>(endpoints.apps.catalog),

  /** One app's full template (runtime catalog — overlay-fresh) for the install
   *  wizard, so a repo-fresh app opens + installs without a redeploy. `draft` is
   *  this org's never-deployed draft of the app, which an install of the same name
   *  ADOPTS — the wizard rehydrates its pickers from it instead of showing template
   *  defaults it would then overwrite. */
  template: (id: string) =>
    api.get<{ data: AppTemplate; draft?: AppOpenDraft | null }>(endpoints.apps.catalogEntry(id)),

  /** Install an app from the catalog. Template apps return the new project;
   *  flow apps return the wizard route to hand off to. `routes` carries the
   *  install wizard's per-endpoint routing choice — it is the ONLY way an app
   *  install gets a public hostname. */
  install: (body: {
    templateId: string;
    name?: string;
    config?: Record<string, string>;
    routes?: InstallAppRoute[];
  }) => api.post<{ data: InstallAppResult }>(endpoints.apps.install, body),

  /** Add a custom app from an uploaded JSON definition (validated + stored per-org,
   *  always unverified). Returns its id; then it appears in the catalog. */
  addCustom: (template: unknown) =>
    api.post<{ data: { appId: string } }>(endpoints.apps.custom, template),

  /** This org's custom (unverified) apps. */
  listCustom: () =>
    api.get<{ data: { appId: string; name: string; updatedAt: string }[] }>(endpoints.apps.custom),

  /** Remove a custom app from this org's catalog. */
  removeCustom: (appId: string) =>
    api.delete<{ data: { ok: true } }>(endpoints.apps.customEntry(appId)),

  /** An installed app's curated settings schema + current values. */
  getSettings: (projectId: string | number) =>
    api.get<{ data: AppSettingsView }>(endpoints.apps.settings(projectId)),

  /** Update an installed app's curated settings (safe env merge). Returns whether
   *  a full redeploy (vs a restart-apply) is needed for the changes to take effect. */
  updateSettings: (projectId: string | number, changes: AppSettingChange[]) =>
    api.patch<{ data: { count: number; requiresRedeploy: boolean } }>(
      endpoints.apps.settings(projectId),
      { changes },
    ),

  /** An installed app's resolved connection details (public URL + generated keys).
   *  Values (incl. secrets) come pre-resolved from the backing services' env. */
  getConnection: (projectId: string | number) =>
    api.get<{ data: AppConnectionView }>(endpoints.apps.connection(projectId)),
};
