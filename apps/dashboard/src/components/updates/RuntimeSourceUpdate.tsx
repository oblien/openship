"use client";

import { useEffect, useRef, useState } from "react";
import type {
  RuntimeSource,
  RuntimeSourceEdit,
  RuntimeSourcePreview,
  RepositoryChangeAccess,
} from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import {
  ApiError,
  getApiErrorCode,
  getApiErrorMessage,
  getApiRequestScopeVersion,
} from "@/lib/api/client";
import { projectsApi } from "@/lib/api/projects";
import { updatesApi } from "@/lib/api/updates";
import {
  RepositoryPathBrowser,
  type RepositorySource,
} from "@/components/github/RepositoryPathBrowser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";

/** Shared source editor for saved settings and security reviews. No deployment side effects. */
export function RuntimeSourceUpdate({
  projectId,
  serviceId,
  initialPath = "Dockerfile",
}: {
  projectId: string;
  serviceId?: string;
  initialPath?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const scope = useCloudResourceKey();
  // A workspace/account switch unmounts the private source and its pending review.
  return (
    <div key={`${scope}:${projectId}:${serviceId ?? ""}`}>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t.projectSettings.sourceImageUpdate.open}
      </Button>
      {open && (
        <SourceEditor
          projectId={projectId}
          serviceId={serviceId}
          initialPath={initialPath}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SourceEditor({
  projectId,
  serviceId,
  initialPath,
  onClose,
}: {
  projectId: string;
  serviceId?: string;
  initialPath: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.sourceImageUpdate;
  const [repo, setRepo] = useState<RepositorySource | null>(null);
  const [path, setPath] = useState(initialPath);
  const [format, setFormat] = useState<"dockerfile" | "compose">(
    /\.ya?ml$/i.test(initialPath) ? "compose" : "dockerfile",
  );
  const [source, setSource] = useState<RuntimeSource | null>(null);
  const [referenceId, setReferenceId] = useState("");
  const [image, setImage] = useState("");
  const [preview, setPreview] = useState<RuntimeSourcePreview | null>(null);
  const [published, setPublished] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [accessFailure, setAccessFailure] = useState<RepositoryChangeAccess | null>(null);
  const [partialPr, setPartialPr] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const mounted = useRef(true);
  const scope = useRef(getApiRequestScopeVersion());
  const current = (request: number) =>
    mounted.current &&
    generation.current === request &&
    scope.current === getApiRequestScopeVersion();
  const acceptSource = (data: RuntimeSource) => {
    setSource(data);
    setReferenceId(data.references[0]?.id ?? "");
    setImage(data.references[0]?.image ?? "");
    setAccessFailure(null);
  };
  const showError = (error: unknown) => {
    setError(getApiErrorMessage(error, copy.failed));
    const code = getApiErrorCode(error);
    if (
      [
        "GITHUB_TOKEN_REQUIRED",
        "REPOSITORY_GITHUB_ACCESS_REQUIRED",
        "REPOSITORY_PR_ACCESS_REQUIRED",
      ].includes(code ?? "")
    )
      setAccessFailure("github_access_required");
    else if (
      ["TOKEN_READ_ONLY", "REPOSITORY_CHANGE_ACCESS_REQUIRED", "GITHUB_ACCESS_DENIED"].includes(
        code ?? "",
      )
    )
      setAccessFailure("workspace_access_required");
  };
  useEffect(() => {
    mounted.current = true;
    const request = ++generation.current;
    setBusy(true);
    projectsApi
      .getGit(projectId)
      .then(async (git) => {
        if (!current(request)) return;
        if (!git.success || git.provider !== "github" || !git.owner || !git.repo || !git.branch) {
          setError(copy.noRepository);
          return;
        }
        setRepo({ owner: git.owner, repo: git.repo, branch: git.branch });
        const { data } = await updatesApi.runtimeSource(projectId, {
          path: initialPath,
          format: /\.ya?ml$/i.test(initialPath) ? "compose" : "dockerfile",
          ...(serviceId && { serviceId }),
        });
        if (current(request)) acceptSource(data);
      })
      .catch((error) => {
        // diagnostics-ignore: showError reports through getApiErrorMessage and displays recovery.
        if (current(request)) showError(error);
      })
      .finally(() => {
        if (current(request)) setBusy(false);
      });
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [projectId, serviceId, initialPath, copy.noRepository, copy.failed]);

  const reset = () => {
    generation.current++;
    setSource(null);
    setPreview(null);
    setError("");
    setAccessFailure(null);
  };
  async function run(action: "load" | "preview" | "publish") {
    if (busy || partialPr || scope.current !== getApiRequestScopeVersion()) return;
    if (action === "publish" && (accessFailure || preview?.publishAccess !== "available")) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    const selection = { path, format, ...(serviceId && { serviceId }) };
    try {
      if (action === "load") {
        setSource(null);
        setPreview(null);
        const { data } = await updatesApi.runtimeSource(projectId, selection);
        if (!current(request)) return;
        acceptSource(data);
      } else {
        if (!source) return;
        const edit: RuntimeSourceEdit = {
          ...selection,
          baseSha: source.baseSha,
          referenceId,
          image,
        };
        if (action === "preview") {
          const { data } = await updatesApi.previewRuntimeSource(projectId, edit);
          if (current(request)) {
            setPreview(data);
            setAccessFailure(null);
            requestId.current = crypto.randomUUID();
          }
        } else if (preview) {
          const { data } = await updatesApi.publishRuntimeSource(projectId, {
            ...edit,
            reviewId: preview.reviewId,
            requestId: requestId.current,
          });
          if (current(request)) setPublished(data.pullRequestUrl ?? data.url);
        }
      }
    } catch (error) {
      // diagnostics-ignore: showError reports through getApiErrorMessage and displays recovery.
      if (current(request)) {
        showError(error);
        if (
          getApiErrorCode(error) === "REPOSITORY_PR_ACCESS_REQUIRED" &&
          error instanceof ApiError
        ) {
          const recoveryUrl = (error.body as { recoveryUrl?: unknown }).recoveryUrl;
          if (typeof recoveryUrl === "string" && recoveryUrl.startsWith("https://github.com/"))
            setPartialPr(recoveryUrl);
        }
      }
    } finally {
      if (current(request)) setBusy(false);
    }
  }
  const before = preview?.before.split("\n") ?? [];
  const after = preview?.after.split("\n") ?? [];
  const changed = before.findIndex((line, index) => line !== after[index]);
  const access = accessFailure ?? preview?.publishAccess ?? source?.publishAccess;

  return (
    <Modal isOpen onClose={onClose} closable={!busy} width="min(760px, 95vw)" zIndex={10020}>
      <div className="space-y-5 p-6">
        <div className="pe-8">
          <h2 className="text-lg font-semibold">{copy.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.hint}</p>
        </div>
        {published ? (
          <div className="space-y-3">
            <a
              className="text-sm underline"
              href={published}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.viewPr}
            </a>
            <p className="text-sm text-muted-foreground">{copy.created}</p>
          </div>
        ) : partialPr ? (
          <a
            className="text-sm underline"
            href={partialPr}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.finishPr}
          </a>
        ) : (
          <>
            {repo && (
              <fieldset disabled={busy} className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  {repo.owner}/{repo.repo} · {repo.branch}
                </p>
                <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                  <label className="space-y-1 text-sm">
                    <span>{copy.file}</span>
                    <Input
                      value={path}
                      onChange={(e) => {
                        reset();
                        setPath(e.target.value);
                      }}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>{copy.format}</span>
                    <CustomSelect
                      aria-label={copy.format}
                      variant="input"
                      disabled={busy}
                      value={format}
                      onChange={(value) => {
                        reset();
                        setFormat(value);
                      }}
                      options={[
                        { value: "dockerfile", label: "Dockerfile" },
                        { value: "compose", label: "Compose" },
                      ]}
                    />
                  </label>
                </div>
                <details>
                  <summary className="cursor-pointer text-sm text-muted-foreground">
                    {copy.browse}
                  </summary>
                  <RepositoryPathBrowser
                    source={repo}
                    kind="file"
                    value={path}
                    onChange={(path) => {
                      reset();
                      setPath(path);
                      setFormat(/\.ya?ml$/i.test(path) ? "compose" : "dockerfile");
                    }}
                  />
                </details>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void run("load")}
                >
                  {copy.load}
                </Button>
                {source && (
                  <>
                    <a
                      className="block text-xs text-muted-foreground underline"
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.path} · {source.baseSha.slice(0, 8)} ↗
                    </a>
                    {source.guidance.map((text, i) => (
                      <p key={i} className="text-sm text-muted-foreground">
                        {text}
                      </p>
                    ))}
                    {!source.references.length && (
                      <p className="text-sm text-muted-foreground">{copy.manual}</p>
                    )}
                    {!!source.references.length && (
                      <>
                        <label className="block space-y-1 text-sm">
                          <span>{copy.reference}</span>
                          <CustomSelect
                            aria-label={copy.reference}
                            variant="input"
                            disabled={busy}
                            value={referenceId}
                            onChange={(value) => {
                              setReferenceId(value);
                              setImage(source.references.find((r) => r.id === value)?.image ?? "");
                              setPreview(null);
                            }}
                            options={source.references.map((ref) => ({
                              value: ref.id,
                              label: ref.label,
                              description: ref.image,
                            }))}
                          />
                        </label>
                        <label className="block space-y-1 text-sm">
                          <span>{copy.image}</span>
                          <Input
                            className="font-mono"
                            value={image}
                            onChange={(e) => {
                              setImage(e.target.value);
                              setPreview(null);
                            }}
                          />
                        </label>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void run("preview")}
                        >
                          {copy.preview}
                        </Button>
                      </>
                    )}
                  </>
                )}
              </fieldset>
            )}
            {preview && (
              <div className="space-y-3">
                <pre
                  aria-label={copy.diff}
                  className="overflow-x-auto rounded-xl bg-background p-4 text-xs"
                  dir="ltr"
                >
                  {before.slice(Math.max(0, changed - 2), changed + 3).map((line, index) => {
                    const i = Math.max(0, changed - 2) + index;
                    return line === after[i] ? (
                      <div key={i}> {line}</div>
                    ) : (
                      <div key={i}>
                        <div className="text-danger">−{line}</div>
                        <div className="text-success">+{after[i]}</div>
                      </div>
                    );
                  })}
                </pre>
                <p className="text-xs text-muted-foreground">{copy.review}</p>
                <Button
                  type="button"
                  disabled={busy || access !== "available"}
                  onClick={() => void run("publish")}
                >
                  {copy.createPr}
                </Button>
              </div>
            )}
          </>
        )}
        {!published && access && access !== "available" && (
          <div role="status" className="space-y-3 rounded-xl bg-background p-4 text-sm">
            <p>{copy[access]}</p>
            <div className="flex flex-wrap items-center gap-3">
              {access === "github_access_required" && (
                <a
                  href="/settings?tab=git"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  {copy.manageConnection}
                </a>
              )}
              {!partialPr && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(preview ? "preview" : "load")}
                >
                  {copy.checkAccess}
                </Button>
              )}
            </div>
          </div>
        )}
        {(busy || (!repo && !error)) && (
          <p role="status" className="text-sm text-muted-foreground">
            {copy.working}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
