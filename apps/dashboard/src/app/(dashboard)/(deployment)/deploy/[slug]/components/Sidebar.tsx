import React, { useCallback } from "react";
import { GitBranch, Rocket, Github, Loader2, Globe, Container, Server, Layers, Check, AlertCircle, Key } from "lucide-react";
import { CustomSelect } from "@/components/ui/CustomSelect";
import DomainSettings from "./DomainSettings";
import BuildSummary from "./BuildSummary";
import RuntimeModeModalContent from "./RuntimeModeModalContent";
import { useDeployment } from "@/context/DeploymentContext";
import { servicesNeedCloud } from "@/context/deployment/types";
import { useCloud } from "@/context/CloudContext";
import { canUseCloudConnection, usePlatform } from "@/context/PlatformContext";
import { useModal } from "@/context/ModalContext";
import { useRouter } from "next/navigation";

// ─── Deploy checklist for compose ────────────────────────────────────────────

const ComposeChecklist: React.FC = () => {
  const { config } = useDeployment();
  const { baseDomain } = usePlatform();
  const services = config.services || [];
  if (services.length === 0) return null;

  const exposedServices = services.filter((s) => s.exposed);
  const exposableServices = services.filter((s) => s.ports.length > 0);
  const envConfigured = services.filter(
    (s) => Object.keys(s.environment).length > 0,
  ).length;
  const totalEnvVars = services.reduce(
    (acc, s) => acc + Object.keys(s.environment).length,
    0,
  );
  const buildServices = services.filter((s) => s.build);

  const checks = [
    {
      label: "Services detected",
      value: `${services.length} services`,
      ok: services.length > 0,
      icon: Layers,
    },
    {
      label: "Public domains",
      value: exposedServices.length > 0
        ? `${exposedServices.length} of ${exposableServices.length} exposed`
        : `${exposableServices.length} can be exposed`,
      ok: exposedServices.length > 0,
      warn: exposedServices.length === 0 && exposableServices.length > 0,
      icon: Globe,
    },
    ...(buildServices.length > 0
      ? [{
          label: "Build services",
          value: `${buildServices.length} to build`,
          ok: true,
          icon: Container,
        }]
      : []),
    {
      label: "Environment",
      value: totalEnvVars > 0
        ? `${totalEnvVars} vars across ${envConfigured} services`
        : "No env vars set",
      ok: totalEnvVars > 0,
      icon: Key,
    },
  ];

  return (
    <div className="bg-card rounded-xl border border-border/50 p-4 space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Deploy Checklist
      </p>
      <div className="space-y-2">
        {checks.map((check) => {
          const Icon = check.icon;
          return (
            <div key={check.label} className="flex items-start gap-2.5">
              <div className={`mt-0.5 p-1 rounded-md ${
                check.ok
                  ? "bg-emerald-500/10 text-emerald-500"
                  : (check as any).warn
                    ? "bg-amber-500/10 text-amber-500"
                    : "bg-muted/50 text-muted-foreground/50"
              }`}>
                {check.ok ? (
                  <Check className="size-3" />
                ) : (check as any).warn ? (
                  <AlertCircle className="size-3" />
                ) : (
                  <Icon className="size-3" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground leading-tight">
                  {check.label}
                </p>
                <p className="text-xs text-muted-foreground leading-snug">
                  {check.value}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Exposed domains quick list */}
      {exposedServices.length > 0 && (
        <div className="pt-2 border-t border-border/30 space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Domains
          </p>
          {exposedServices.map((svc) => {
            const domain =
              svc.domainType === "custom" && svc.customDomain
                ? svc.customDomain
                : `${svc.domain || svc.name}.${baseDomain}`;
            return (
              <div key={svc.name} className="flex items-center gap-2">
                <Globe className="size-3 text-primary" />
                <span className="text-sm text-primary font-medium truncate">{domain}</span>
                <span className="text-xs text-muted-foreground ml-auto">{svc.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Sidebar ─────────────────────────────────────────────────────────────────

const Sidebar: React.FC = () => {
  const { config, state, updateConfig, startDeployment } = useDeployment();
  const { requireCloud } = useCloud();
  const { baseDomain, selfHosted, deployMode } = usePlatform();
  const { showModal, hideModal } = useModal();
  const router = useRouter();
  const isServices = config.projectType === "services";
  const isDockerRuntimeProject = config.projectType === "docker" || config.projectType === "services";
  const canConnectCloud = canUseCloudConnection({ selfHosted, deployMode });

  // Self-hosted server apps need a runtime mode choice before deploying
  const needsRuntimeChoice =
    config.deployTarget !== "cloud" && config.options.hasServer && !isDockerRuntimeProject;

  const executeDeploy = useCallback(async (runtimeMode?: typeof config.runtimeMode) => {
    const deploymentId = await startDeployment(
      runtimeMode ? { runtimeMode } : undefined,
    );
    if (deploymentId) {
      router.push(`/build/${deploymentId}`);
    }
  }, [startDeployment, router]);

  const continueDeploy = useCallback(async () => {
    if (needsRuntimeChoice) {
      let modalId = "";
      modalId = showModal({
        customContent: (
          <RuntimeModeModalContent
            initialRuntimeMode={config.runtimeMode}
            serverId={config.serverId}
            onClose={() => hideModal(modalId)}
            onConfirm={async (runtimeMode) => {
              updateConfig({ runtimeMode });
              hideModal(modalId);
              await executeDeploy(runtimeMode);
            }}
          />
        ),
        maxWidth: "420px",
        showCloseButton: false,
      });
      return;
    }

    await executeDeploy();
  }, [config.runtimeMode, config.serverId, executeDeploy, hideModal, needsRuntimeChoice, showModal, updateConfig]);

  const handleDeploy = useCallback(async () => {
    if (config.deployTarget === "cloud") {
      if (!requireCloud("Deploying to Openship Cloud")) return;
    }

    if (!isServices && canConnectCloud && config.deployTarget !== "cloud" && config.domainType === "free") {
      if (!requireCloud({
        feature: `Using free .${baseDomain} domains on your own server`,
        description: `Free .${baseDomain} domains are routed through Openship Cloud. To deploy this project to your own server, either connect Openship Cloud or switch this project to a custom domain.`,
        secondaryHint: "If you do not want to connect Openship Cloud, change the project domain from free to custom before deploying.",
      })) return;
    }

    // Compose services with free managed domains require cloud
    if (isServices && servicesNeedCloud(config.services)) {
      if (!requireCloud({
        feature: `Using free .${baseDomain} domains for your services`,
        description: `One or more exposed services use free .${baseDomain} domains. To deploy them to your own server, either connect Openship Cloud or switch those services to custom domains.`,
        secondaryHint: "Custom domains work without Openship Cloud. Free managed domains do not.",
      })) return;
    }

    if (isServices && shouldWarnAboutUnreachableServices(config.services)) {
      let modalId = "";
      modalId = showModal({
        customContent: (
          <div className="p-6 space-y-5">
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-foreground">No public service is reachable</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                This stack has app services with ports, but none of them are configured with a public domain.
                If you deploy now, the services can run internally, but users will not be able to access them from a URL.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Before deploying</p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>Pick the service that should be public.</li>
                <li>Enable exposure for that service.</li>
                <li>Set a subdomain or custom domain and choose the public port.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
                onClick={() => hideModal(modalId)}
              >
                Review Services
              </button>
              <button
                type="button"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={async () => {
                  hideModal(modalId);
                  await continueDeploy();
                }}
              >
                Deploy Anyway
              </button>
            </div>
          </div>
        ),
        maxWidth: "560px",
      });
      return;
    }

    await continueDeploy();
  }, [baseDomain, canConnectCloud, config.deployTarget, config.domainType, config.services, continueDeploy, hideModal, isServices, requireCloud, showModal]);

  return (
    <div className="lg:sticky lg:top-6 h-fit space-y-4">
      {/* Repository Info */}
      <div className="border border-border/50 rounded-xl bg-card overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 pt-3 pb-0">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444]/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#eab308]/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e]/60" />
        </div>
        <div className="p-4 pt-3">
          <div className="flex items-center gap-3">
            <Github className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {config.owner}/{config.repo}
              </p>
            </div>
          </div>
          {config.branches.length > 0 && (
            <div className="mt-3">
              <CustomSelect
                value={config.branch}
                onChange={(val) => updateConfig({ branch: val })}
                options={config.branches.map(branch => ({
                  value: branch,
                  label: branch,
                  icon: <GitBranch className="w-3.5 h-3.5" />
                }))}
                placeholder="Select branch"
                className="w-full"
              />
            </div>
          )}
          {config.branches.length === 0 && config.branch && (
            <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
              <GitBranch className="size-3" />
              {config.branch}
            </div>
          )}
        </div>
      </div>

      {/* Domain — per-service for compose, checklist for others */}
      {isServices ? (
        <ComposeChecklist />
      ) : (
        <DomainSettings
          projectName={config.projectName}
          domain={config.domain}
          setDomain={(val) => updateConfig({ domain: val })}
          customDomain={config.customDomain}
          setCustomDomain={(val) => updateConfig({ customDomain: val })}
          domainType={config.domainType}
          setDomainType={(val) => updateConfig({ domainType: val })}
        />
      )}

      {/* Deploy */}
      <button
        onClick={handleDeploy}
        disabled={state.isDeploying}
        className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {state.isDeploying ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Deploying…
          </>
        ) : (
          <>
            <Rocket className="size-4" />
            Deploy
          </>
        )}
      </button>

      {/* Build Summary */}
      <BuildSummary />
    </div>
  );
};

export default React.memo(Sidebar);

function hasConnectedDomain(service: {
  exposed?: boolean;
  domainType?: "free" | "custom";
  customDomain?: string;
  domain?: string;
  name?: string;
}) {
  if (!service.exposed) return false;
  if (service.domainType === "custom") return Boolean(service.customDomain?.trim());
  return Boolean(service.domain?.trim() || service.name?.trim());
}

function shouldWarnAboutUnreachableServices(services: Array<{
  image?: string;
  name: string;
  ports: string[];
  exposed?: boolean;
  domainType?: "free" | "custom";
  customDomain?: string;
  domain?: string;
}>) {
  const candidates = services.filter((service) => service.ports.length > 0);
  if (candidates.length === 0) return false;
  return candidates.every((service) => !hasConnectedDomain(service));
}
