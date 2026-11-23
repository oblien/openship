import { DEFAULT_GIT_PROVIDER, gitProviderDefinition } from "@repo/core";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { isServicesFramework, normalizeRepoPath } from "@repo/core";
import type {
  ProjectDetails,
  RepositoryChangeAccess,
  RuntimeSource,
  RuntimeSourceEdit,
  RuntimeSourceInput,
  RuntimeSourcePreview,
} from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import type { RepositorySource } from "@/components/github/RepositoryPathBrowser";
import {
  ApiError,
  getApiErrorCode,
  getApiErrorMessage,
  getApiRequestScopeVersion,
} from "@/lib/api/client";
import { projectsApi } from "@/lib/api/projects";
import { updatesApi } from "@/lib/api/updates";

type SourceFile = Pick<RuntimeSourceInput, "path" | "format">;
export type EditorAction =
  | { kind: "initialize" }
  | { kind: "load"; file: SourceFile; keepDraft?: boolean }
  | { kind: "preview" }
  | { kind: "publish" };
type SourceProject = ProjectDetails["project"] & { composePath?: string | null };

const isComposeFile = (path: string) => /\.(ya?ml|json)$/i.test(path);

function deploymentSourceFile(project: SourceProject): SourceFile {
  const compose =
    project.projectType === "services" ||
    isServicesFramework(project.framework) ||
    Boolean(project.composePath);
  if (compose && project.composePath && isComposeFile(project.composePath)) {
    return { path: normalizeRepoPath(project.composePath) ?? "", format: "compose" };
  }
  const folder = (compose && project.composePath) || project.rootDirectory || "";
  const name = compose ? "docker-compose.yml" : "Dockerfile";
  return {
    path: normalizeRepoPath([folder, name].join("/")) ?? "",
    format: compose ? "compose" : "dockerfile",
  };
}

export type EditorTarget = { projectId: string; serviceId?: string };

/** Owns the source selection and the review tied to it. */
export function useRuntimeSourceEditor({ projectId, serviceId }: EditorTarget) {
  const { t } = useI18n();
  const copy = t.projectSettings.sourceImageUpdate;
  const [repo, setRepo] = useState<RepositorySource | null>(null);
  const [file, setFile] = useState<SourceFile>({ path: "", format: "dockerfile" });
  const [source, setSource] = useState<RuntimeSource | null>(null);
  const [referenceId, setReferenceId] = useState("");
  const [image, setImage] = useState("");
  const [preview, setPreview] = useState<RuntimeSourcePreview | null>(null);
  const [published, setPublished] = useState("");
  const [partialPr, setPartialPr] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState<EditorAction["kind"] | null>("initialize");
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [accessFailure, setAccessFailure] = useState<RepositoryChangeAccess | null>(null);
  const publication = useRef<{ reviewId: string; requestId: string } | null>(null);
  const pending = useRef<object | null>(null);
  const scope = useRef(getApiRequestScopeVersion());
  const reference = source?.references.find((item) => item.id === referenceId);
  const edited = Boolean(reference && image.trim() && image.trim() !== reference.image);
  const access = accessFailure ?? preview?.publishAccess ?? source?.publishAccess;

  function chooseFile(file: SourceFile) {
    setFile(file);
    setSource(null);
    setReferenceId("");
    setImage("");
    setPreview(null);
    setAccessFailure(null);
    setError(null);
  }

  async function run(action: EditorAction) {
    if (pending.current || scope.current !== getApiRequestScopeVersion() || published || partialPr)
      return;
    if (action.kind === "publish" && (!preview || access !== "available")) return;
    const request = {};
    pending.current = request;
    const isCurrent = () =>
      pending.current === request && scope.current === getApiRequestScopeVersion();
    setBusy(action.kind);
    setError(null);
    try {
      if (action.kind === "initialize" || action.kind === "load") {
        let selection: SourceFile;
        if (action.kind === "initialize") {
          const response = await projectsApi.getInfo(projectId);
          if (!isCurrent()) return;
          const project: SourceProject | undefined = response.data?.project;
          if (!response.success || !project) {
            setError({ message: copy.failed });
            return;
          }
          const { gitProvider, gitOwner, gitRepo, gitBranch } = project;
          if (!gitProviderDefinition(gitProvider)?.capabilities.sourceChanges || !gitOwner || !gitRepo || !gitBranch) {
            setError({ message: copy.noRepository });
            return;
          }
          setRepo({ provider: gitProvider ?? DEFAULT_GIT_PROVIDER, owner: gitOwner, repo: gitRepo, branch: gitBranch });
          selection = deploymentSourceFile(project);
          chooseFile(selection);
        } else {
          selection = action.file;
        }
        if (!selection.path) {
          setBrowsing(true);
          return;
        }
        const { data } = await updatesApi.runtimeSource(projectId, {
          ...selection,
          ...(serviceId && { serviceId }),
        });
        if (!isCurrent()) return;
        setRepo({ provider: data.provider, owner: data.owner, repo: data.repo, branch: data.branch });
        setFile({ ...selection, path: data.path });
        setSource(data);
        const retained =
          action.kind === "load" && action.keepDraft
            ? data.references.find((item) => item.id === referenceId)
            : undefined;
        setReferenceId(retained?.id ?? data.references[0]?.id ?? "");
        if (!retained) setImage("");
        setPreview(null);
        setAccessFailure(null);
        setBrowsing(false);
        return;
      }
      if (!source || !reference || !edited) return;
      const edit: RuntimeSourceEdit = {
        ...file,
        ...(serviceId && { serviceId }),
        baseSha: source.baseSha,
        referenceId,
        image: image.trim(),
      };
      if (action.kind === "preview") {
        const { data } = await updatesApi.previewRuntimeSource(projectId, edit);
        if (!isCurrent()) return;
        setPreview(data);
        setAccessFailure(null);
        if (publication.current?.reviewId !== data.reviewId) {
          publication.current = { reviewId: data.reviewId, requestId: crypto.randomUUID() };
        }
      } else if (preview && publication.current) {
        const { data } = await updatesApi.publishRuntimeSource(projectId, {
          ...edit,
          reviewId: preview.reviewId,
          requestId: publication.current.requestId,
        });
        if (isCurrent()) setPublished(data.pullRequestUrl ?? data.url);
      }
    } catch (cause) {
      // diagnostics-ignore: getApiErrorMessage records this error before rendering recovery.
      if (!isCurrent()) return;
      const code = getApiErrorCode(cause);
      const message = getApiErrorMessage(cause, copy.failed);
      setError({
        message: cause instanceof ApiError && cause.status === 500 ? copy.failed : message,
        requestId: cause instanceof ApiError ? cause.requestId : undefined,
      });
      if (code === "RUNTIME_SOURCE_CHANGED" || code === "RUNTIME_SOURCE_FILE_NOT_FOUND") {
        setSource(null);
        setPreview(null);
      }
      if (code === "RUNTIME_SOURCE_FILE_NOT_FOUND") setBrowsing(true);
      if (
        [
          "GITHUB_TOKEN_REQUIRED",
          "REPOSITORY_GITHUB_ACCESS_REQUIRED",
          "REPOSITORY_PR_ACCESS_REQUIRED",
        ].includes(code ?? "")
      ) {
        setAccessFailure("github_access_required");
      } else if (
        ["TOKEN_READ_ONLY", "REPOSITORY_CHANGE_ACCESS_REQUIRED", "GITHUB_ACCESS_DENIED"].includes(
          code ?? "",
        )
      ) {
        setAccessFailure("workspace_access_required");
      }
      if (code === "REPOSITORY_PR_ACCESS_REQUIRED" && cause instanceof ApiError) {
        const url = (cause.body as { recoveryUrl?: unknown })?.recoveryUrl;
        if (typeof url === "string" && url.startsWith("https://github.com/")) setPartialPr(url);
      }
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setBusy(null);
      }
    }
  }

  const initialize = useEffectEvent(() => void run({ kind: "initialize" }));
  useEffect(() => {
    initialize();
    return () => {
      pending.current = null;
    };
  }, []);

  function changePath(path: string) {
    chooseFile({ path, format: isComposeFile(path) ? "compose" : file.format });
  }

  function selectFile(path: string) {
    const next: SourceFile = { path, format: isComposeFile(path) ? "compose" : "dockerfile" };
    chooseFile(next);
    void run({ kind: "load", file: next });
  }

  function changeImage(value: string) {
    setImage(value);
    setPreview(null);
    setError(null);
  }

  function changeReference(id: string) {
    setReferenceId(id);
    changeImage("");
  }

  return {
    repo,
    file,
    source,
    reference,
    referenceId,
    image,
    edited,
    preview,
    published,
    partialPr,
    browsing,
    setBrowsing,
    busy,
    error,
    access,
    run,
    changePath,
    selectFile,
    changeImage,
    changeReference,
    changeFormat: (format: SourceFile["format"]) => chooseFile({ ...file, format }),
  };
}
