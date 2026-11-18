"use client";

import { useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { RepositoryPathBrowser } from "@/components/github/RepositoryPathBrowser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";
import { RuntimeSourceDiff } from "./RuntimeSourceDiff";
import {
  useRuntimeSourceEditor,
  type EditorAction,
  type EditorTarget,
} from "./useRuntimeSourceEditor";

/** Shared entry point for app settings, service settings, and security review. */
export function RuntimeSourceUpdate({ projectId, serviceId }: EditorTarget) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t.projectSettings.sourceImageUpdate.open}
      </Button>
      {open && (
        <RuntimeSourceUpdateDialog
          projectId={projectId}
          serviceId={serviceId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function RuntimeSourceUpdateDialog({
  projectId,
  serviceId,
  onClose,
}: EditorTarget & { onClose: () => void }) {
  const scope = useCloudResourceKey();
  return (
    <SourceEditor
      key={JSON.stringify([scope, projectId, serviceId])}
      projectId={projectId}
      serviceId={serviceId}
      onClose={onClose}
    />
  );
}

function SourceEditor({ projectId, serviceId, onClose }: EditorTarget & { onClose: () => void }) {
  const { t } = useI18n();
  const copy = t.projectSettings.sourceImageUpdate;
  const headingId = useId();
  const pathId = useId();
  const {
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
    changeFormat,
  } = useRuntimeSourceEditor({ projectId, serviceId });
  const close = () => {
    if (busy !== "publish") onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);

  const done = published || partialPr;
  const disabled = busy !== null;
  let primary: { label: string; action: EditorAction; blocked?: boolean } | undefined;
  if (!repo && error) {
    primary = { label: t.chrome.apiDown.retry, action: { kind: "initialize" } };
  } else if (repo && !source) {
    primary = { label: copy.load, action: { kind: "load", file }, blocked: !file.path.trim() };
  } else if (preview) {
    primary = {
      label: copy.createPr,
      action: { kind: "publish" },
      blocked: access !== "available",
    };
  } else if (reference) {
    primary = { label: copy.preview, action: { kind: "preview" }, blocked: !edited };
  }

  return (
    <Modal
      isOpen
      onClose={close}
      closable={busy !== "publish"}
      showCloseButton={false}
      overflow="hidden"
      width="900px"
      maxWidth="calc(100vw - 2rem)"
      maxHeight="88dvh"
      zIndex={10020}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-4 sm:px-7 sm:pt-6">
          <div className="min-w-0">
            <h2 id={headingId} className="text-xl font-medium">
              {copy.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{copy.hint}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={close}
            disabled={busy === "publish"}
            aria-label={t.settings.common.close}
          >
            <Icon name="close" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5 sm:px-7">
          {done
            ? published && (
                <p className="rounded-2xl bg-card p-4 text-sm text-muted-foreground">
                  {copy.created}
                </p>
              )
            : repo && (
                <>
                  <section className="space-y-3 rounded-2xl bg-card p-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="flex min-w-0 items-center gap-2 font-medium" dir="ltr">
                        <Icon name="github" className="size-4 shrink-0 text-muted-foreground" />
                        <span className="wrap-anywhere">
                          {repo.owner}/{repo.repo} · {repo.branch}
                        </span>
                      </span>
                      {source && (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={source.baseSha}
                          className="ms-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <span className="font-mono" dir="ltr">
                            {source.baseSha.slice(0, 8)}
                          </span>
                          <Icon name="arrow-up-right" className="size-3.5" />
                        </a>
                      )}
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-48 flex-1 space-y-1.5">
                        <label htmlFor={pathId} className="block text-xs text-muted-foreground">
                          {copy.file}
                        </label>
                        <Input
                          id={pathId}
                          variant="filled"
                          className="font-mono"
                          dir="ltr"
                          value={file.path}
                          disabled={disabled}
                          onChange={(event) => changePath(event.target.value)}
                        />
                      </div>
                      <Button
                        variant="secondary"
                        disabled={disabled}
                        aria-expanded={browsing}
                        onClick={() => setBrowsing(!browsing)}
                      >
                        <Icon name="folder" />
                        {copy.browse}
                      </Button>
                    </div>
                    {!source && (
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>{copy.format}</span>
                        <CustomSelect
                          aria-label={copy.format}
                          variant="filled"
                          triggerClassName="bg-muted/60 hover:bg-muted"
                          disabled={disabled}
                          value={file.format}
                          onChange={changeFormat}
                          options={[
                            { value: "dockerfile", label: "Dockerfile" },
                            { value: "compose", label: "Compose" },
                          ]}
                        />
                      </div>
                    )}
                    {browsing && (
                      <fieldset disabled={disabled}>
                        <RepositoryPathBrowser
                          source={repo}
                          kind="file"
                          value={file.path}
                          onChange={selectFile}
                        />
                      </fieldset>
                    )}
                  </section>

                  {source && (
                    <section className="space-y-3">
                      {reference ? (
                        <div className="grid items-start gap-3 sm:grid-cols-2">
                          <div className="min-w-0 space-y-1.5">
                            <p className="text-xs text-muted-foreground">{copy.reference}</p>
                            {source.references.length > 1 ? (
                              <>
                                <CustomSelect
                                  aria-label={copy.reference}
                                  variant="filled"
                                  triggerClassName="bg-muted/60 hover:bg-muted"
                                  disabled={disabled}
                                  value={referenceId}
                                  options={source.references.map((ref) => ({
                                    value: ref.id,
                                    label: ref.label,
                                    description: ref.image,
                                  }))}
                                  onChange={changeReference}
                                />
                                <p
                                  className="wrap-anywhere font-mono text-xs text-muted-foreground"
                                  dir="ltr"
                                >
                                  {reference.image}
                                </p>
                              </>
                            ) : (
                              <p className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-muted/60 px-3.5 py-2 text-sm">
                                <code className="wrap-anywhere" dir="ltr">
                                  {reference.image}
                                </code>
                                <span className="text-xs text-muted-foreground">
                                  {reference.label}
                                </span>
                              </p>
                            )}
                          </div>
                          <label className="block min-w-0 space-y-1.5 text-xs text-muted-foreground">
                            <span>{copy.image}</span>
                            <Input
                              variant="filled"
                              className="font-mono"
                              dir="ltr"
                              placeholder={reference.image}
                              disabled={disabled}
                              value={image}
                              onChange={(event) => changeImage(event.target.value)}
                            />
                          </label>
                        </div>
                      ) : (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-sm text-muted-foreground underline underline-offset-4"
                        >
                          {copy.manual}
                        </a>
                      )}
                      {source.guidance.map((line, index) => (
                        <p key={index} className="text-xs text-muted-foreground">
                          {line}
                        </p>
                      ))}
                    </section>
                  )}

                  {preview && <RuntimeSourceDiff preview={preview} />}
                </>
              )}

          {busy && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="spinner" className="size-4 animate-spin" />
              {copy.working}
            </p>
          )}
          {error && (
            <div role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
              <p>{error.message}</p>
              {error.requestId && (
                <p className="mt-1 font-mono text-xs" dir="ltr">
                  {t.chrome.error.refCode} {error.requestId}
                </p>
              )}
            </div>
          )}
          {!published && access && access !== "available" && (
            <div role="status" className="space-y-2 rounded-xl bg-card p-4 text-sm">
              <p>{copy[access]}</p>
              <div className="flex flex-wrap items-center gap-2">
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
                {!partialPr && repo && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled || !file.path}
                    onClick={() =>
                      preview
                        ? void run({ kind: "preview" })
                        : void run({ kind: "load", file, keepDraft: true })
                    }
                  >
                    {copy.checkAccess}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/60 px-5 py-3 sm:px-7">
          <Button variant="ghost" disabled={busy === "publish"} onClick={close}>
            {t.settings.common.close}
          </Button>
          {done ? (
            <Button asChild>
              <a href={done} target="_blank" rel="noopener noreferrer">
                {published ? copy.viewPr : copy.finishPr}
              </a>
            </Button>
          ) : (
            primary && (
              <Button
                disabled={disabled || primary.blocked}
                onClick={() => void run(primary.action)}
              >
                {primary.label}
              </Button>
            )
          )}
        </footer>
      </div>
    </Modal>
  );
}
