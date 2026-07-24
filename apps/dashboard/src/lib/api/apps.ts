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
  /** Not installable this version — render dimmed + block install. */
  comingSoon?: boolean;
  configFields: AppCatalogField[];
}

export type InstallAppResult =
  | { kind: "flow"; flowHref: string }
  | { kind: "template"; projectId: string; slug: string };

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

/** One resolved connection value (URL or generated key) for the app Overview. */
export interface AppConnectionOutput {
  id: string;
  label: string;
  help?: string;
  secret: boolean;
  /** Resolved value; "" when not resolvable yet (renders as "—"). */
  value: string;
}

export interface AppConnectionView {
  title?: string;
  description?: string;
  outputs: AppConnectionOutput[];
}

export const appsApi = {
  /** The installable app catalog. */
  catalog: () => api.get<{ data: AppCatalogEntry[] }>(endpoints.apps.catalog),

  /** One app's full template (runtime catalog — overlay-fresh) for the install
   *  wizard, so a repo-fresh app opens + installs without a redeploy. */
  template: (id: string) => api.get<{ data: AppTemplate }>(endpoints.apps.catalogEntry(id)),

  /** Install an app from the catalog. Template apps return the new project;
   *  flow apps return the wizard route to hand off to. */
  install: (body: { templateId: string; name?: string; config?: Record<string, string> }) =>
    api.post<{ data: InstallAppResult }>(endpoints.apps.install, body),

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
