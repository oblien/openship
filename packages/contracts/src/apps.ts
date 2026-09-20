import { Type, type Static } from "@sinclair/typebox";
import { isValidAppTemplate, type AppTemplate } from "@repo/core";
import { AddCustomAppBody, AppSettingsPatchBody, InstallAppBody } from "./app-inputs";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const localized = Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]);
const management = Type.Union([Type.Object({ kind: Type.Literal("schema") }), Type.Object({ kind: Type.Literal("custom"), href: Type.String() }), Type.Null()]);
const minResources = Type.Object({ cpuCores: Type.Optional(Type.Number()), memoryMb: Type.Optional(Type.Number()) });
const requiresUpdate = Type.Object({ minVersion: Type.Optional(Type.String()) });
const endpointMode = Type.Union([Type.Literal("internal"), Type.Literal("port"), Type.Literal("publish"), Type.Literal("domain")]);
const endpoints = Type.Array(Type.Object({
  service: Type.String(), port: Type.Number(), label: Type.String(), kind: Type.Union([Type.Literal("http"), Type.Literal("tcp")]),
  required: Type.Optional(Type.Boolean()), scope: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("internal"), Type.Literal("local")])),
  defaultMode: Type.Optional(endpointMode), allowedModes: Type.Optional(Type.Array(endpointMode)),
}));

export type ResolvedAppTemplate = AppTemplate & { requiresUpdate?: { minVersion?: string }; updateAvailable?: boolean };
/** The existing catalog validator checks the complete template, including cross-field references. */
const template = Type.Unsafe<ResolvedAppTemplate>(Type.Object({ id: Type.String(), name: Type.String(), kind: Type.Union([Type.Literal("template"), Type.Literal("flow")]) }));
export const AppCatalogSummarySchema = Type.Object({
  id: Type.String(), name: Type.String(), description: Type.String(), kind: Type.Union([Type.Literal("template"), Type.Literal("flow")]),
  logo: Type.String(), category: Type.String(), tags: Type.Array(Type.String()), flowHref: Type.Optional(Type.String()), management,
  verified: Type.Boolean(), hosting: Type.Union([Type.Literal("self-hosted"), Type.Literal("experimental")]),
  minResources: Type.Optional(minResources), custom: Type.Boolean(), comingSoon: Type.Boolean(),
  requiresUpdate: Type.Optional(requiresUpdate), updateAvailable: Type.Optional(Type.Boolean()), endpoints,
  configFields: Type.Array(Type.Object({ key: Type.String(), service: Type.String(), label: Type.String(), help: Type.Optional(Type.String()),
    type: Type.Union([Type.Literal("text"), Type.Literal("password")]), default: Type.Optional(Type.String()), required: Type.Boolean() })),
});
export type AppCatalogSummary = Static<typeof AppCatalogSummarySchema>;
export const AppCatalogEntrySchema = Type.Object({
  template, draft: Type.Union([Type.Object({ projectId: Type.String(), slug: Type.String(), name: Type.String() }), Type.Null()]),
});
export const AppHostFitInputSchema = Type.Object({ deployTarget: Type.Optional(Type.String()), serverId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const HostCapacitySchema = Type.Object({
  cpuCores: Type.Number(), memoryMb: Type.Number(), source: Type.Union([Type.Literal("docker"), Type.Literal("local"), Type.Literal("unknown")]),
});
const shortfall = Type.Object({ needed: Type.Number(), available: Type.Number() });
export const AppHostFitSchema = Type.Object({
  minResources: Type.Union([minResources, Type.Null()]), capacity: HostCapacitySchema,
  fit: Type.Object({ ok: Type.Boolean(), memory: Type.Optional(shortfall), cpu: Type.Optional(shortfall) }),
});
export type AppHostFit = Static<typeof AppHostFitSchema>;
export const InstallAppResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("flow"), flowHref: Type.String() }),
  Type.Object({ kind: Type.Literal("template"), projectId: Type.String(), slug: Type.String() }),
]);
export type InstallAppInput = Static<typeof InstallAppBody>;
export type InstallAppResult = Static<typeof InstallAppResultSchema>;

export const AppCollectionSchemas = {
  listCatalog: { action: "read", scope: "list", output: Type.Array(AppCatalogSummarySchema) },
  listCustom: { action: "read", scope: "list", output: Type.Array(Type.Object({ appId: Type.String(), name: Type.String(), updatedAt: Type.String() })) },
  saveCustom: { action: "write", input: Type.Unsafe<AppTemplate>(AddCustomAppBody), output: Type.Object({ appId: Type.String() }) },
  install: { action: "write", projectCreate: true, input: InstallAppBody, output: InstallAppResultSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const AppResourceSchemas = {
  getCatalogEntry: { action: "read", scope: "list", output: AppCatalogEntrySchema,
    outputCheck: (value: unknown) => isValidAppTemplate((value as { template: unknown }).template) },
  hostFit: { action: "read", scope: "list", input: AppHostFitInputSchema, optionalInput: true, output: AppHostFitSchema },
  removeCustom: { action: "write", output: Type.Object({ ok: Type.Literal(true) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface AppOperations extends ScopedOperations<typeof AppCollectionSchemas>, ResourceOperations<typeof AppResourceSchemas> {}

const field = Type.Object({
  key: Type.String(), service: Type.String(), label: Type.String(), help: Type.Optional(Type.String()),
  type: Type.Union((["text", "password", "boolean", "select", "number", "multiselect", "radio", "textarea"] as const).map(value => Type.Literal(value))),
  options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: Type.String() }))),
  separator: Type.Optional(Type.String()), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), step: Type.Optional(Type.Number()),
  integer: Type.Optional(Type.Boolean()), pattern: Type.Optional(Type.String()), patternError: Type.Optional(Type.String()), default: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()), secret: Type.Optional(Type.Boolean()), trueValue: Type.Optional(Type.String()), falseValue: Type.Optional(Type.String()),
  requiresRedeploy: Type.Optional(Type.Boolean()), advanced: Type.Optional(Type.Boolean()), installStep: Type.Optional(Type.Boolean()), required: Type.Optional(Type.Boolean()),
  showIf: Type.Optional(Type.Object({ field: Type.String(), service: Type.Optional(Type.String()), equals: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), truthy: Type.Optional(Type.Boolean()) })),
});
export const AppSettingsSchema = Type.Object({
  appTemplateId: nullableString, management,
  groups: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), description: Type.Optional(Type.String()), fields: Type.Array(field) })),
  values: Type.Array(Type.Object({ service: Type.String(), key: Type.String(), value: Type.String(), secret: Type.Boolean(), set: Type.Boolean() })),
});
export type AppSettings = Static<typeof AppSettingsSchema>;
export const AppConnectionSchema = Type.Object({
  title: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
  outputs: Type.Array(Type.Object({
    id: Type.String(), label: Type.String(), help: Type.Optional(Type.String()), secret: Type.Boolean(), value: Type.String(),
    envKey: Type.Optional(Type.String()), service: nullableString, recommended: Type.Optional(Type.Boolean()), sourceLabel: Type.Optional(localized),
    sourceServiceId: Type.Optional(Type.String()),
    variants: Type.Optional(Type.Array(Type.Object({ id: Type.String(), label: localized, value: Type.String() }))),
    width: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("half")])), kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("url")])), internal: Type.Optional(Type.Boolean()),
  })),
  guide: Type.Optional(Type.Object({ intro: Type.Optional(localized), useHint: Type.Optional(localized), defaultMode: Type.Optional(Type.Union([Type.Literal("internal"), Type.Literal("public")])) })),
});
export type AppConnection = Static<typeof AppConnectionSchema>;
export const AppProjectSchemas = {
  getAppSettings: { action: "read", output: AppSettingsSchema },
  updateAppSettings: { action: "write", input: AppSettingsPatchBody, output: Type.Object({ count: Type.Number(), requiresRedeploy: Type.Boolean() }) },
  // Deliberately returns curated credentials; the existing HTTP route requires write authority.
  getAppConnection: { action: "write", output: AppConnectionSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
