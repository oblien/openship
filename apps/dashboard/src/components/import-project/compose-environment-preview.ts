import {
  ENV_MASK,
  isMaskedValue,
  mergeServiceDeployEnv,
  resolveComposeValue,
  type ComposeEnvironmentMeta,
} from "@repo/core";
import type { ComposeServiceInfo } from "@/context/deployment/types";
import type { EnvironmentVariable } from "./types";
import { draftServiceOverrides } from "@/lib/service-environment-editor";

/** Keep the editor's effective values separate from the source recipe it saves. */
export function composeEnvironmentPreview(
  service: ComposeServiceInfo,
  projectRows: readonly EnvironmentVariable[],
  sourceRows: readonly EnvironmentVariable[] = [],
) {
  const project = Object.fromEntries(
    [...sourceRows, ...projectRows]
      .filter((row) => row.key.trim())
      .map((row) => [row.key, row.preserveValue ? ENV_MASK : row.value]),
  );
  const templateKeys =
    service.advanced?.environmentTemplateKeys ??
    (service.environmentTemplates ? Object.keys(service.environmentTemplates) : undefined);
  const inline = { ...service.environment };
  for (const key of templateKeys ?? []) {
    if (Object.hasOwn(service.environmentTemplates ?? {}, key)) {
      inline[key] = service.environmentTemplates![key]!;
    }
  }
  const overrides = service.environmentDraft ? draftServiceOverrides(service.environmentDraft) : {};
  const merged = mergeServiceDeployEnv(
    { project, frozen: {}, inline, templateKeys, service: overrides },
    false,
  );
  for (const [key, value] of Object.entries(service.environmentDraft?.generated ?? {})) {
    if (!Object.hasOwn(merged.env, key)) merged.env[key] = value;
  }
  const environment = Object.fromEntries(
    Object.keys(service.environmentDraft ? merged.env : service.environment).map((key) => {
      const value = merged.env[key] ?? "";
      // A derived URL containing a saved secret is still secret, not a partial preview.
      return [key, value.includes(ENV_MASK) ? ENV_MASK : value];
    }),
  );
  const environmentMeta: Record<string, ComposeEnvironmentMeta> = { ...service.environmentMeta };
  for (const key of templateKeys ?? []) {
    if (!Object.hasOwn(inline, key) || isMaskedValue(inline[key])) continue;
    const scope = { ...merged.env };
    if (Object.hasOwn(project, key)) scope[key] = project[key]!;
    else delete scope[key];
    const { meta } = resolveComposeValue(inline[key]!, scope);
    if (meta) environmentMeta[key] = { ...meta, resolvedValue: environment[key] ?? "" };
  }
  return { environment, environmentMeta };
}

/** Viewing or hiding a default must not turn it into a permanent literal. */
export function editComposeEnvironment(
  service: ComposeServiceInfo,
  displayed: Record<string, string>,
  edited: Record<string, string>,
): Partial<ComposeServiceInfo> {
  const unchanged = new Set(
    Object.keys(edited).filter(
      (key) => Object.hasOwn(displayed, key) && edited[key] === displayed[key],
    ),
  );
  const environment = Object.fromEntries(
    Object.entries(edited).map(([key, value]) => [
      key,
      unchanged.has(key) ? service.environment[key]! : value,
    ]),
  );
  const templateKeys = (
    service.advanced?.environmentTemplateKeys ?? Object.keys(service.environmentTemplates ?? {})
  ).filter((key) => unchanged.has(key));
  return {
    environment,
    advanced: { ...service.advanced, environmentTemplateKeys: templateKeys },
    ...(service.environmentTemplates && {
      environmentTemplates: Object.fromEntries(
        Object.entries(service.environmentTemplates).filter(([key]) => unchanged.has(key)),
      ),
    }),
    ...(service.environmentMeta && {
      environmentMeta: Object.fromEntries(
        Object.entries(service.environmentMeta).filter(([key]) => Object.hasOwn(edited, key)),
      ),
    }),
  };
}
