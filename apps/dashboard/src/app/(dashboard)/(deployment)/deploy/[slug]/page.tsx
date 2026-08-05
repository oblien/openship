"use client";

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import DockerSettings from "@/components/import-project/DockerSettings";
import ComposeServices from "@/components/import-project/ComposeServices";
import { ComposePathField } from "@/components/import-project/ComposePathField";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import MonorepoApps from "@/components/import-project/MonorepoApps";
import RoutingSection from "@/components/import-project/RoutingSection";
import ReadinessSection from "@/components/project-settings/ReadinessSection";
import Sidebar from "./components/Sidebar";
import DeployTargetStep, { DeployTargetSummary, lastPickStore, useDesktopTargets, useSeedDeployTarget } from "./components/DeployTargetStep";
// Clone-strategy gate moved from inline render to a preflight modal
// triggered from <Sidebar>'s handleDeploy. The inline placement was
// wrong (showed before the user clicked Deploy). See
// CloneStrategyNudge.tsx for the hook + modal-content exports.
import { decodeSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment } from "@/context/deployment/types";
import { usePlatform, canUseCloudConnection } from "@/context/PlatformContext";
import SkeletonLoader from "./components/SkeletonLoader";
import ErrorState from "@/components/shared/ErrorState";
import { PageContainer } from "@/components/ui/PageContainer";
import { useToast } from "@/components/toast";
import { useI18n } from "@/components/i18n-provider";

interface DeployError {
    type: 'invalid_url' | 'repo_not_found' | 'initialization_failed';
    message: string;
    details?: string;
}

const ProjectName: React.FC = () => {
    const { config, updateConfig } = useDeployment();
    const { t } = useI18n();
    return (
        <div className="bg-card rounded-2xl border border-border/50">
            <div className="px-5 py-5">
                <label className="text-[15px] font-semibold text-foreground mb-2 block">
                    {t.deploy.page.projectNameLabel}
                </label>
                <input
                    type="text"
                    value={config.projectName}
                    onChange={(e) => updateConfig({ projectName: e.target.value })}
                    placeholder="my-awesome-project"
                    className="w-full px-4 py-2.5 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                />
                <p className="text-sm text-muted-foreground mt-1.5">
                    {t.deploy.page.projectNameHint}
                </p>
            </div>
        </div>
    );
};

const DeployRepository: React.FC = () => {
    const params = useParams();
    const slug = params.slug as string;
    const { config, initializeFromRepo, initializeFromLocal, initializeFromUpload, initializeFromProject, updateConfig } = useDeployment();
    const { deployMode, selfHosted } = usePlatform();
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const force = searchParams.get("force") || undefined;
    const projectId = searchParams.get("projectId") || undefined;
    const branch = searchParams.get("branch") || undefined;
    // Folder-upload: the user picked the stack up front (no auto-detection);
    // carry it (and the folder name) so the wizard seeds from the stack defaults.
    const uploadStack = searchParams.get("stack") || undefined;
    const uploadName = searchParams.get("name") || undefined;
    // Edit-from-Runtime-tab: hydrate from SAVED settings, skip repo re-detection.
    const isConfigEdit = searchParams.get("mode") === "config" && !!projectId;
    // Desktop AND self-hosted pick a deploy target (this box / a registered server
    // / cloud) — only the multi-tenant SaaS always deploys to cloud. Self-hosted
    // was wrongly excluded, so its target picker never mounted and the "cloud"
    // DEFAULT_CONFIG value silently shipped ("Build Location: Openship Cloud").
    // Reuse the shared "self-managed, not SaaS" predicate instead of re-deriving
    // it inline; the picker's own auto-select already prefers "This Server". #263
    const canPickTarget = canUseCloudConnection({ selfHosted, deployMode });

    // Decode the slug at render time so the skeleton can name the source
    // ("Fetching owner/repo from GitHub") on the very first paint, before the
    // async initialize call resolves.
    const decodedSource = React.useMemo(() => {
        const d = slug ? decodeSlug(slug) : null;
        if (!d) return null;
        // Config-edit hydrates from saved data — surface that, not "Fetching from GitHub".
        if (isConfigEdit) {
            const label =
                d.kind === "local" ? d.path
                    : d.kind === "upload" ? t.deploy.page.uploadedFolder
                    : d.kind === "project" ? ""
                    : `${d.owner}/${d.repo}`;
            return { kind: "settings" as const, label };
        }
        if (d.kind === "local") return { kind: "local" as const, path: d.path };
        if (d.kind === "upload") return { kind: "local" as const, path: t.deploy.page.uploadedFolder };
        // Repo-less app: hydrated from saved rows, no git fetch — neutral summary.
        if (d.kind === "project") return { kind: "settings" as const, label: "" };
        return {
            kind: "repo" as const,
            owner: d.owner,
            repo: d.repo,
            branch: branch ?? d.branch,
        };
    }, [slug, branch, isConfigEdit, t]);

    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<DeployError | null>(null);
    const hasInitialized = useRef<boolean>(false);
    const { toast } = useToast();

    // Desktop-only: resolve available deploy targets (server / cloud)
    const targets = useDesktopTargets();

    // Existing/saved projects (config-edit, or a repo-less one-click / services
    // project) already carry a deploy target — it hydrates from
    // initializeFromProject. The silent seed stays OFF for them so it can never
    // overwrite that saved target with the user's global default.
    const decodedForTarget = React.useMemo(() => (slug ? decodeSlug(slug) : null), [slug]);
    const isExistingProject = isConfigEdit || decodedForTarget?.kind === "project";

    // Seed the deploy target SILENTLY so the config view's summary bar is correct
    // without ever mounting the full target step. New deploys only.
    useSeedDeployTarget(targets, canPickTarget && !isExistingProject);

    // The wizard ALWAYS lands on the config step. The deploy target is seeded
    // silently — applyLastPick (below, useLayoutEffect) for the fast localStorage
    // path, useSeedDeployTarget (above) for the settings/server default — and is
    // shown in the DeployTargetSummary bar at the top of the config view.
    // Clicking that bar (onEdit) is the only way into the full target picker.
    //
    // Previously first-time users (no soft last-pick) started on "target", which
    // can't know the servers/default synchronously: the step mounted, showed a
    // centered spinner while listServers() / settingsApi.get() / cloud resolved,
    // then auto-advanced by calling onContinue() — the visible "spin then bounce"
    // flash. Landing on config and seeding silently removes it entirely.
    const [step, setStep] = useState<"target" | "config">("config");

    // Apply the soft last-pick to config so step="config" renders with the
    // correct target/serverId. Runs TWICE:
    //   Pass 1: pre-paint (useLayoutEffect) so the summary bar doesn't
    //           flash with DEFAULT_CONFIG.deployTarget="cloud".
    //   Pass 2: AFTER initializeFromRepo's setConfig settles — that path
    //           goes through buildPreparedConfig which overwrites
    //           buildStrategy / runtimeMode based on stack defaults,
    //           clobbering the user's last pick. The applied flag is
    //           reset right before pass 2 so it fires once more.
    const appliedLastPickRef = useRef(false);

    const applyLastPick = useCallback(() => {
        // Don't override a SAVED project's hydrated target (same gate as
        // useSeedDeployTarget) — the last-pick memory is for NEW deploys only.
        if (!canPickTarget || isExistingProject || appliedLastPickRef.current) return;
        const last = typeof window !== "undefined" ? lastPickStore.read() : null;
        if (!last) return;
        if (last.target === "server") {
            // lastPickStore is a browser-GLOBAL key, so this serverId may be from
            // another project/org or a since-removed server. Replay it ONLY when
            // it's a live target in THIS org's list (mirrors useSeedDeployTarget's
            // gate) — otherwise leave appliedLastPickRef UNconsumed so pass-2 (after
            // targets load) can retry, and fall through to the validated seed rather
            // than submitting a serverId the deploy's org doesn't own.
            if (!last.serverId || !targets.servers.some((s) => s.id === last.serverId)) return;
            appliedLastPickRef.current = true;
            updateConfig({ deployTarget: "server", serverId: last.serverId });
        } else if (last.target === "cloud") {
            appliedLastPickRef.current = true;
            updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
        } else if (last.target === "local") {
            appliedLastPickRef.current = true;
            updateConfig({ deployTarget: "local", serverId: undefined });
        }
    }, [canPickTarget, isExistingProject, targets.servers, updateConfig]);

    useLayoutEffect(() => {
        applyLastPick();
    }, [applyLastPick]);

    // Single-server safety net. The picker's own auto-select (DeployTargetStep)
    // only runs while that step is MOUNTED — so on the auto-skip path (one
    // server → picker skipped), config.serverId stays unset and both the summary
    // ("My Server" fallback) and the deploy lose the target. Mirror the
    // auto-select here so the lone server's id is always wired, picker or not.
    useEffect(() => {
        if (
            config.deployTarget === "server" &&
            !config.serverId &&
            targets.servers.length === 1
        ) {
            updateConfig({ serverId: targets.servers[0].id });
        }
    }, [config.deployTarget, config.serverId, targets.servers, updateConfig]);

    // Cloud always builds in the cloud runtime. The full target step enforces
    // buildStrategy="server" for a cloud target while it's open; replicate just
    // that rule here so it also holds on the config view (where the step isn't
    // mounted) — otherwise repo-init can reseed buildStrategy from the stack
    // default and ship a cloud deploy with a local build strategy.
    useEffect(() => {
        if (config.deployTarget === "cloud" && config.buildStrategy !== "server") {
            updateConfig({ buildStrategy: "server" });
        }
    }, [config.deployTarget, config.buildStrategy, updateConfig]);

    // Track whether the user explicitly came back to step 1 via the edit
    // affordance. If they did, we must NOT auto-skip past it again - they
    // came here to make a change. Reset to true only on initial mount.
    const autoSkipTargetRef = useRef(true);

    useEffect(() => {
        const initialize = async () => {
            if (hasInitialized.current || !slug) return;
            hasInitialized.current = true;

            const decoded = decodeSlug(slug);

            if (!decoded) {
                setError({
                    type: 'invalid_url',
                    message: t.deploy.page.errorInvalidUrlTitle,
                    details: t.deploy.page.errorInvalidUrlDetails
                });
                setLoading(false);
                return;
            }

            let result;
            if (isConfigEdit && projectId) {
                // Saved-only hydration — no deployApi.prepare, no GitHub round-trip.
                // Single-app loads instantly from getInfo+getEnv; compose/monorepo
                // delegate to the detection path inside initializeFromProject.
                result = await initializeFromProject(projectId, {
                    branch: branch ?? (decoded.kind === "repo" ? decoded.branch : undefined),
                });
            } else if (decoded.kind === "project") {
                // Repo-less project (one-click app / saved services project): hydrate
                // straight from its DB rows — services, env, exposed ports — in DEPLOY
                // mode (no ?mode=config), so the sidebar stays "Deploy", not "Save".
                result = await initializeFromProject(decoded.projectId, { branch });
            } else if (decoded.kind === "local") {
                result = await initializeFromLocal(decoded.path, { projectId });
            } else if (decoded.kind === "upload") {
                result = await initializeFromUpload(decoded.sessionId, {
                    projectId,
                    stack: uploadStack,
                    name: uploadName,
                });
            } else {
                result = await initializeFromRepo(decoded.owner, decoded.repo, force, {
                    branch: branch ?? decoded.branch,
                    projectId: projectId ?? decoded.projectId,
                });
            }

            // Re-apply last-pick: initializeFromRepo's buildPreparedConfig
            // overwrites buildStrategy + runtimeMode from the detected stack's
            // defaults, which clobbers what useLayoutEffect set above. Reset
            // the guard and re-apply so the summary bar (and the rest of the
            // page) reflects the user's actual saved preference.
            if (result.success) {
                appliedLastPickRef.current = false;
                applyLastPick();
            }

            if (!result.success) {
                // If build is already in progress, redirect to build page (handled elsewhere)
                if ('buildInProgress' in result && result.buildInProgress) {
                    setLoading(false);
                    return;
                }

                // Handle specific error cases. We surface BOTH the full-page
                // ErrorState (so the user can read the detail + retry) AND a
                // toast (so the error doesn't go unnoticed if they navigated
                // away). Network errors already trigger the global toast via
                // NetworkErrorHandler — only fire here for api_error so we
                // don't double-toast network failures.
                if (result.error) {
                    setError({
                        type: result.errorType === 'api_error' ? 'repo_not_found' : 'initialization_failed',
                        message: decoded.kind === 'local' ? t.deploy.page.errorLoadProjectTitle : t.deploy.page.errorLoadRepoTitle,
                        details: result.error
                    });
                    if (result.errorType === 'api_error') {
                        toast('error', result.error);
                    }
                } else {
                    const fallbackDetail = decoded.kind === 'local'
                        ? t.deploy.page.errorScanFolderFailed
                        : t.deploy.page.errorLoadRepoFailed;
                    setError({
                        type: 'initialization_failed',
                        message: decoded.kind === 'local' ? t.deploy.page.errorLoadProjectTitle : t.deploy.page.errorLoadRepoTitle,
                        details: fallbackDetail
                    });
                    toast('error', fallbackDetail);
                }
            }
            
            setLoading(false);
        };

        initialize();
    }, [slug, initializeFromRepo, initializeFromLocal, initializeFromUpload, initializeFromProject, isConfigEdit, force, projectId, branch, uploadStack, uploadName, toast, t]);

    if (loading) {
        return <SkeletonLoader source={decodedSource} />;
    }

    if (error) {
        return (
            <ErrorState 
                type="repo-not-found" 
                error={{
                    message: error.message,
                    details: error.details
                }}
            />
        );
    }

    if (!config.repo || !config.owner) {
        return null;
    }

    const isServiceDeployment = usesServiceDeployment(config);
    const isMonorepoFlow = config.projectType === "monorepo";
    const isSingleAppFlow =
        !isMonorepoFlow &&
        (config.projectType === "app" || (config.projectType === "services" && !isServiceDeployment));

    const deploymentSections = (
        <>
            {config.projectType === "app" && (
                <>
                    <ProjectSettings />
                    <BuildSettings />
                </>
            )}
            {config.projectType === "docker" && <DockerSettings />}
            {config.projectType === "services" && <ComposeServices />}
            {isMonorepoFlow && <MonorepoApps />}
            {/* Outside every type-specific section on purpose: a repo whose compose
                file lives in a subfolder scans as an app/docker project, and applying
                a path flips this to `services` — so the control has to survive that
                flip to stay correctable. */}
            {!isServiceDeployment &&
                !(isMonorepoFlow && config.serviceDeploymentMode !== "single") && (
                <EnvironmentVariables collapsible />
            )}
            {/* Both of these sit AFTER env and outside every type-specific section:
                they're project-level opt-ins that apply to whatever this deploy
                turns out to be, and a control nested in the app/docker section
                would vanish the moment applying a compose path flipped the wizard
                to `services`. Readiness covers a port/path probe for a server, a
                doc-root+index probe for a static site, and a restart-loop watch for
                containers; compose services can override it individually in the
                service's own settings. Both collapsed and off unless opened. */}
            <ComposePathField />
            <ReadinessSection
                value={config.readiness}
                onChange={(next) => updateConfig({ readiness: next ?? null })}
            />
            <ProjectName />
            {(config.projectType === "app" || isMonorepoFlow) && <RoutingSection />}
        </>
    );

    return (
        <PageContainer>
                {/* Step 1: Deploy target picker - centered onboarding style (desktop only).
                    DeployTargetStep owns its own max-width: it widens to two columns
                    when a right-hand panel (cloud power / server runtime) is shown, and
                    stays narrow single-column otherwise. The page just centers it. */}
                {step === "target" && canPickTarget && (
                    <div className="flex items-center justify-center min-h-[calc(100vh-8rem)] py-8">
                        <DeployTargetStep
                            targets={targets}
                            autoSkipAllowed={autoSkipTargetRef.current}
                            onContinue={() => setStep("config")}
                            projectId={projectId}
                        />
                    </div>
                )}

                {/* Step 2: Project configuration */}
                {step === "config" && (
                    <div className="grid lg:grid-cols-[1fr_340px] gap-6">
                        <div className="space-y-5">
                            {/* Target summary bar — click to go back to step 1 (desktop + self-hosted) */}
                            {canPickTarget && (
                                <DeployTargetSummary
                                    deployTarget={config.deployTarget}
                                    buildStrategy={config.buildStrategy}
                                    showBuildStrategy={isSingleAppFlow}
                                    cloudResourceTier={config.cloudResourceTier}
                                    hasServer={config.options.hasServer}
                                    runtimeMode={config.runtimeMode}
                                    isServices={usesServiceDeployment(config)}
                                    rollbackWindow={config.rollbackWindow}
                                    rollbackStrategy={config.rollbackStrategy}
                                    serverName={(() => {
                                        // Resolve the selected server by id; if id isn't set yet but
                                        // there's exactly one server, use it (covers the paint before
                                        // the single-server auto-select effect wires serverId).
                                        const s = config.serverId
                                            ? targets.servers.find((x) => x.id === config.serverId)
                                            : targets.servers.length === 1
                                                ? targets.servers[0]
                                                : undefined;
                                        return s?.name ?? s?.sshHost ?? null;
                                    })()}
                                    onEdit={() => {
                                        // User explicitly came back to change something - don't
                                        // auto-skip them past the picker again.
                                        autoSkipTargetRef.current = false;
                                        setStep("target");
                                    }}
                                />
                            )}

                            {deploymentSections}
                        </div>
                        <Sidebar />
                    </div>
                )}
        </PageContainer>
    );
};

export default DeployRepository;
