"use client";

import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { RoutingConfigCard } from "./RoutingConfigCard";
import {
  RouteProtectionPanel,
  routeProtectionHref,
} from "@/components/routing/RouteProtectionButton";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useRouter, useSearchParams } from "next/navigation";
import { EdgePagesPanel } from "@/components/routing/EdgePagesPanel";
import { RouteRules } from "./RouteRules";

export function DomainSection({
  section,
}: {
  section: "routing" | "proxy" | "access" | "edge-pages";
}) {
  const { projectData, setProjectData } = useProjectSettings();
  const id = String(projectData.id);
  const cloud = projectData.deployTarget === "cloud" || !!projectData.workspaceId;
  const domains = (projectData.domains ?? [])
    .map((domain) => ({
      hostname: domain.hostname ?? domain.domain,
      external: domain.externalIngress || domain.domainType === "free",
    }))
    .filter((domain): domain is { hostname: string; external: boolean } => !!domain.hostname);
  if (section === "routing" || section === "proxy")
    return (
      <RoutingConfigCard
        id={id}
        section={section}
        isCloudProject={cloud}
        initial={projectData.routingConfig}
        onSaved={(routingConfig) => setProjectData((current) => ({ ...current, routingConfig }))}
      />
    );
  if (cloud || projectData.deployTarget === "cluster" || projectData.clusterId) return null;
  if (section === "edge-pages")
    return (
      <EdgePagesPanel
        projectId={id}
        hostnames={domains.map((domain) => domain.hostname)}
        onSaved={(edgePages) =>
          setProjectData((current) => ({
            ...current,
            routingConfig: { ...current.routingConfig, edgePages },
          }))
        }
      />
    );
  return (
    <div className="space-y-5">
      <AccessSettings projectId={id} domains={domains} />
      <RouteRules />
    </div>
  );
}

function AccessSettings({
  projectId,
  domains,
}: {
  projectId: string;
  domains: { hostname: string; external?: boolean }[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const requested = useSearchParams().get("hostname");
  const selected = domains.find((domain) => domain.hostname === requested) ?? domains[0];
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">{t.widgets.routing.protection.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.widgets.routing.pages.accessHint}</p>
        </div>
        {selected && (
          <CustomSelect
            aria-label={t.widgets.routing.protection.chooseHostname}
            value={selected.hostname}
            options={domains.map((domain) => ({
              value: domain.hostname,
              label: domain.hostname,
            }))}
            onChange={(hostname) =>
              router.replace(routeProtectionHref(projectId, hostname), { scroll: false })
            }
            className="w-full sm:w-72"
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
          />
        )}
      </div>
      {selected ? (
        <RouteProtectionPanel
          projectId={projectId}
          hostname={selected.hostname}
          unsupported={selected.external}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t.widgets.routing.protection.chooseHostname}
        </p>
      )}
    </section>
  );
}
