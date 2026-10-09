"use client";
import { DeployActions } from "@/components/actions/DeployActions";

import React, { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import DockerSettings from "@/components/import-project/DockerSettings";
import ComposeServices from "@/components/import-project/ComposeServices";
import { ComposePathField } from "@/components/import-project/ComposePathField";
import { ConfigDiagnostics } from "@/components/import-project/ConfigDiagnostics";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import MonorepoApps from "@/components/import-project/MonorepoApps";
import RoutingSection from "@/components/import-project/RoutingSection";
import ReadinessSection from "@/components/project-settings/ReadinessSection";
import Sidebar from "./components/Sidebar";
import DeployTargetStep, { DeployTargetSummary } from "./components/DeployTargetStep";
import { useServerRuntimeSelection } from "./components/ServerRuntimePicker";
// Clone-strategy gate moved from inline render to a preflight modal
// triggered from <Sidebar>'s handleDeploy. The inline placement was
// wrong (showed before the user clicked Deploy). See
// CloneStrategyNudge.tsx for the hook + modal-content exports.
import { decodeSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment, workloadOf } from "@/context/deployment/types";
import { usePlatform } from "@/context/PlatformContext";
import SkeletonLoader from "./components/SkeletonLoader";
import ErrorState from "@/components/shared/ErrorState";
import { useServerSelection } from "@/components/shared/ServerSelector";
import { PageContainer } from "@/components/ui/PageContainer";
import { Input } from "@/components/ui/input";
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
        <div className="bg-card rounded-2xl">
            <div className="px-5 py-5">
                <label htmlFor="deploy-project-name" className="text-sm font-semibold text-foreground mb-2 block">
                    {t.deploy.page.projectNameLabel}
                </label>
                <Input
                    id="deploy-project-name"
                    variant="filled"
                    type="text"
                    value={config.projectName}
                    onChange={(e) => updateConfig({ projectName: e.target.value })}
                    placeholder="my-awesome-project"
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                    {t.deploy.page.projectNameHint}
                </p>
            </div>
        </div>
    );
};

const DeployRepository: React.FC = () => {
    const params = useParams();
    const slug = params.slug as string;
    const { config, state, isRescanning, initializeFromRepo, initializeFromLocal, initializeFromUpload, initializeFromProject, updateConfig } = useDeployment();
    const { selfHosted } = usePlatform();
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

    // A saved project pins the deploy target only if it actually HAS one, so the gate is
    // the hydration RESULT, not the fact that a project is being loaded:
    //   "pending" — config-edit or a repo-less project/services deploy, target not read
    //               back yet. Seeders off, so the summary bar can't flash a default
    //               before the real target lands.
    //   "saved"   — initializeFromProject hydrated one. Seeders stay off; nothing may
    //               overwrite it with the user's global default.
    //   "none"    — hydration ran and the project is bound to nothing and has never
    //               deployed (a repo-less catalog app whose first deploy is this one).
    //               Seeders take over so the destination goes through the same validated
    //               pick a fresh deploy gets. This branch is the bug: it used to be
    //               "saved" by assumption, no hydration existed to make it true, and
    //               DEFAULT_CONFIG's "cloud" rode all the way into the deploy payload.
    const decodedForTarget = React.useMemo(() => (slug ? decodeSlug(slug) : null), [slug]);
    const loadsSavedTarget = isConfigEdit || decodedForTarget?.kind === "project";
    const [savedTargetState, setSavedTargetState] = useState<"pending" | "saved" | "none">(
        loadsSavedTarget ? "pending" : "none",
    );
    // Own the selector state above both views. Switching between the summary and
    // target settings must not refetch, reseed or replace the chosen Cloud server.
    const serverSelection = useServerSelection({
        value: config.serverId,
        selectedName: config.serverName,
        readOnly: !!config.serverId && (!!config.uploadSessionId || (!!config.projectId && !!config.workspaceId)),
        disabled: loading || isRescanning || state.isDeploying,
        disabledReason: config.uploadSessionId
            ? t.billing.workspaces.uploadDestinationHint
            : config.projectId && config.workspaceId ? t.billing.workspaces.savedDestinationHint : undefined,
        forDeployment: true,
        autoSelectFirst: savedTargetState === "none",
        useSavedDefault: savedTargetState === "none",
        onSelect: (server) => updateConfig({
            deployTarget: server ? (server.raw.managed ? "cloud" : "server") : (selfHosted ? "server" : "cloud"),
            serverId: server?.id,
            workspaceId: server?.raw.managed?.id,
            serverName: server?.name,
            buildStrategy: "server",
        }),
    }, !loading && savedTargetState !== "pending" && config.deployTarget !== "cluster");

    const runtimeSelection = useServerRuntimeSelection({
        memoryMb: serverSelection.selected?.managed?.resources?.memoryMb,
        enabled: !loading && !isRescanning && !state.isDeploying && savedTargetState !== "pending" && config.deployTarget !== "cluster",
    });

    const [step, setStep] = useState<"target" | "config">("config");

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

            if (result.success && loadsSavedTarget) {
                setSavedTargetState("savedTarget" in result && result.savedTarget ? "saved" : "none");
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
    }, [slug, initializeFromRepo, initializeFromLocal, initializeFromUpload, initializeFromProject, isConfigEdit, loadsSavedTarget, force, projectId, branch, uploadStack, uploadName, toast, t]);

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
            <DeployActions />
            {(config.projectType === "app" || isMonorepoFlow) && <RoutingSection />}
        </>
    );

    return (
        <PageContainer>
                {/* Destination settings share the page's normal content/sidebar layout. */}
                {step === "target" && (
                    <DeployTargetStep
                        serverSelection={serverSelection}
                        runtimeSelection={runtimeSelection}
                        onContinue={() => setStep("config")}
                        onBack={() => setStep("config")}
                        projectId={projectId}
                    />
                )}

                {/* Step 2: Project configuration */}
                {step === "config" && (
                    <div className="grid lg:grid-cols-[1fr_340px] gap-6">
                        <div className="space-y-5">
                            {/* One destination summary and editor in Cloud and self-hosted. */}
                            <DeployTargetSummary
                                deployTarget={config.deployTarget}
                                buildStrategy={config.buildStrategy}
                                showBuildStrategy={isSingleAppFlow}
                                cloudResourceTier={config.cloudResourceTier}
                                cloudStaticHosting={config.cloudStaticHosting ?? "pages"}
                                hasServer={workloadOf(config.options) !== "static"}
                                runtimeMode={config.runtimeMode}
                                isServices={usesServiceDeployment(config)}
                                rollbackWindow={config.rollbackWindow}
                                rollbackStrategy={config.rollbackStrategy}
                                serverName={serverSelection.selected?.name || config.serverName || (
                                    serverSelection.loading ? t.widgets.shared.serverSelector.loadingServers
                                        : serverSelection.readOnly && config.serverId ? t.billing.workspaces.singular
                                        : serverSelection.automaticCloud ? t.deploy.summary.targetCloud
                                        : t.widgets.shared.serverSelector.selectServer
                                )}
                                onEdit={() => setStep("target")}
                            />
                            {serverSelection.error && <p role="alert" className="text-sm text-danger">{serverSelection.error}</p>}

                            {/* Above every type-specific section: a refused
                                openship.json field can belong to any of them, and
                                the notice must survive the `app → services` flip
                                that applying a compose path causes (#641). */}
                            <ConfigDiagnostics />
                            {deploymentSections}
                        </div>
                        <Sidebar destinationReady={(config.deployTarget === "cluster" && !!config.projectId) || serverSelection.ready} />
                    </div>
                )}
        </PageContainer>
    );
};

export default DeployRepository;
