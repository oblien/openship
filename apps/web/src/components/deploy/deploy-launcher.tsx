"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { DeployReadme } from "./deploy-readme";
import { useRepositoryBranding } from "./use-repository-branding";
import { AppLogo } from "@repo/ui/app-logo";
import {
  CLOUD_DASHBOARD_URL,
  deployInstallCommand,
  deployLinkHref,
  deploySetupHref,
  parseDeploySource,
  type DeploySource,
} from "@repo/core";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import "./deploy-launcher.css";

type AppSummary = {
  id: string;
  name: string;
  logo: string;
  supportsCloud: boolean;
  kind: "template" | "flow";
};

export function DeployLauncher({
  source,
  app,
  error,
}: {
  source: DeploySource | null;
  app?: AppSummary;
  error?: string;
}) {
  const copy = useCopy();
  const router = useRouter();
  const [step, setStep] = useState<"destination" | "server">("destination");
  const [repo, setRepo] = useState("");
  const [formError, setFormError] = useState("");
  const [installed, setInstalled] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const branding = useRepositoryBranding(source);
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const command = source ? deployInstallCommand(source, installed) : "";
  const cloudUrl = source
    ? new URL(deploySetupHref(source, "cloud"), CLOUD_DASHBOARD_URL).href
    : "";
  const manageUrl = source
    ? new URL(deploySetupHref(source, "server"), CLOUD_DASHBOARD_URL).href
    : "";
  const title =
    app?.name ??
    branding?.name ??
    (source?.kind === "repo" ? `${source.owner}/${source.repo}` : "");
  const canCloud = app?.supportsCloud !== false && app?.kind !== "flow";

  async function copyText(text: string) {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      // diagnostics-ignore: clipboard access can be denied; offer manual copying inline.
      setCopyError(true);
    }
  }

  return (
    <div className="deploy-launcher">
      <header className="deploy-header">
        <div className="deploy-header-title">
          <Link href="/" className="deploy-brand">
            <span aria-hidden className="deploy-brand-mark" />
            OpenShip
          </Link>
          <span className="deploy-header-divider" aria-hidden />
          <span className="deploy-header-label">{copy("Deploy")}</span>
        </div>
        <Link href="/docs/guides/deploy-button" className="deploy-text-link">
          <Icon name="book" size={16} aria-hidden />
          {copy("Documentation")}
        </Link>
      </header>
      <main className="deploy-main">
        <div className={`deploy-workspace${source ? "" : " deploy-workspace--empty"}`}>
          {source && (
            <aside className="deploy-source" aria-label={copy("Deployment source")}>
              <div className="deploy-source-heading">
                <span className="deploy-source-icon" aria-hidden>
                  {app ? (
                    <AppLogo
                      appId={app.id}
                      slug={app.logo}
                      invertOnDark={false}
                      className="size-9"
                    />
                  ) : branding?.logoUrl && failedLogo !== branding.logoUrl ? (
                    <img
                      key={branding.logoUrl}
                      src={branding.logoUrl}
                      alt=""
                      width={36}
                      height={36}
                      className="deploy-repo-logo"
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      onError={(event) => setFailedLogo(event.currentTarget.src)}
                    />
                  ) : (
                    <Icon name="github" size={32} />
                  )}
                </span>
                <div>
                  <span className="deploy-source-label">
                    {copy(source.kind === "repo" ? "Repository" : "App")}
                  </span>
                  <strong className="deploy-source-name">
                    <bdi>{title}</bdi>
                  </strong>
                </div>
              </div>
              <div className="deploy-source-details">
                {source.kind === "repo" ? (
                  <>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="deploy-text-link"
                    >
                      <Icon name="github" size={15} aria-hidden />
                      {branding?.name ? (
                        <bdi>
                          {source.owner}/{source.repo}
                        </bdi>
                      ) : (
                        copy("GitHub repository")
                      )}
                      <Icon name="arrow-up-right" size={14} aria-hidden />
                    </a>
                    <span className="deploy-source-branch">
                      <Icon name="git-branch" size={15} aria-hidden />
                      <bdi>{source.branch ?? copy("Default branch")}</bdi>
                    </span>
                  </>
                ) : (
                  <Link href={`/apps/${source.appId}`} className="deploy-text-link">
                    <Icon name="layers" size={15} aria-hidden />
                    {copy("App catalog")}
                    <Icon name="arrow-up-right" size={14} aria-hidden />
                  </Link>
                )}
              </div>
              <div className="deploy-source-note">
                {source.kind === "repo" ? (
                  <Icon name="file-code" size={18} aria-hidden />
                ) : (
                  <Icon name="settings" size={18} aria-hidden />
                )}
                <p>
                  {source.kind === "repo"
                    ? copy(
                        "Commit openship.json to configure this project. No catalog listing required.",
                      )
                    : copy("Review your app’s settings before anything is deployed.")}
                </p>
              </div>
            </aside>
          )}
          <div className="deploy-content">
            {!source ? (
              <section className="deploy-intro">
                <div className="deploy-intro-art" aria-hidden>
                  <span>
                    <Icon name="github" size={28} />
                  </span>
                  <i />
                  <span className="deploy-intro-brand">
                    <span className="deploy-brand-mark" />
                  </span>
                </div>
                <h1>{copy("Deploy with OpenShip")}</h1>
                <p>{copy("Deploy any GitHub repository. No catalog listing required.")}</p>
                {error && (
                  <p role="alert" className="deploy-error">
                    {copy(error)}
                  </p>
                )}
                <form
                  className="deploy-repo-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      router.push(deployLinkHref(parseDeploySource({ repo })));
                    } catch (cause) {
                      // diagnostics-ignore: invalid user-entered repository URLs are shown inline.
                      setFormError(
                        cause instanceof Error ? cause.message : "Invalid repository URL.",
                      );
                    }
                  }}
                >
                  <label htmlFor="deploy-repo">{copy("GitHub repository")}</label>
                  <div className="deploy-repo-input">
                    <Icon name="github" size={19} aria-hidden />
                    <input
                      id="deploy-repo"
                      type="url"
                      required
                      value={repo}
                      placeholder="https://github.com/owner/repo"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={formError ? "repo-error" : undefined}
                      aria-invalid={!!formError}
                      onChange={(event) => {
                        setRepo(event.target.value);
                        setFormError("");
                      }}
                    />
                  </div>
                  {formError && (
                    <p id="repo-error" role="alert" className="deploy-error">
                      {copy(formError)}
                    </p>
                  )}
                  <button className="deploy-primary" type="submit">
                    {copy("Choose destination")}
                    <Icon name="arrow-right" size={18} />
                  </button>
                </form>
                <Link href="/apps" className="deploy-catalog-link">
                  <span className="deploy-catalog-icon">
                    <Icon name="layers" size={22} aria-hidden />
                  </span>
                  <span>
                    <strong>{copy("Start with a ready-to-run app")}</strong>
                    <span>{copy("Explore databases, tools and services")}</span>
                  </span>
                  <Icon name="arrow-right" size={18} aria-hidden />
                </Link>
              </section>
            ) : (
              <>
                {step === "destination" ? (
                  <>
                    <div className="deploy-heading">
                      <h1>{copy("Choose your destination")}</h1>
                      <p>{copy("Choose where to run this project.")}</p>
                    </div>
                    <div className="deploy-options">
                      <section
                        className="deploy-option deploy-option--cloud"
                        aria-labelledby="deploy-cloud-title"
                      >
                        <div className="deploy-option-top">
                          <span className="deploy-option-icon">
                            <Icon name="cloud" size={25} aria-hidden />
                          </span>
                          <span>{copy("Managed hosting")}</span>
                        </div>
                        <h2 id="deploy-cloud-title">{copy("OpenShip Cloud")}</h2>
                        <p>{copy("Hosting and infrastructure managed for you.")}</p>
                        <ul>
                          <li>
                            <Icon name="check" size={16} aria-hidden />
                            {copy("Hosting, routing and HTTPS")}
                          </li>
                          <li>
                            <Icon name="check" size={16} aria-hidden />
                            {copy("Use a plan or choose a new one")}
                          </li>
                        </ul>
                        {canCloud ? (
                          <a href={cloudUrl} className="deploy-primary">
                            {copy("Continue with Cloud")}
                            <Icon name="arrow-right" size={18} />
                          </a>
                        ) : (
                          <p className="deploy-unavailable">
                            {copy("This app runs on your own server.")}
                          </p>
                        )}
                      </section>
                      <section className="deploy-option" aria-labelledby="deploy-server-title">
                        <div className="deploy-option-top">
                          <span className="deploy-option-icon">
                            <Icon name="server" size={25} aria-hidden />
                          </span>
                          <span>{copy("Self-hosted")}</span>
                        </div>
                        <h2 id="deploy-server-title">{copy("Your own server")}</h2>
                        <p>{copy("Run OpenShip on a server you own.")}</p>
                        <ul>
                          <li>
                            <Icon name="check" size={16} aria-hidden />
                            {copy("One command to get started")}
                          </li>
                          <li>
                            <Icon name="check" size={16} aria-hidden />
                            {copy("Free and open source")}
                          </li>
                        </ul>
                        <button
                          type="button"
                          onClick={() => setStep("server")}
                          className="deploy-secondary"
                        >
                          {copy("Use my server")}
                          <Icon name="arrow-right" size={18} />
                        </button>
                      </section>
                    </div>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="deploy-text-link deploy-back"
                      onClick={() => setStep("destination")}
                    >
                      <Icon name="arrow-left" size={16} />
                      {copy("Change destination")}
                    </button>
                    <div className="deploy-heading">
                      <h1>{copy("Deploy on your server")}</h1>
                      <p>{copy("SSH into your server, then run this command.")}</p>
                    </div>
                    <section className="deploy-terminal">
                      <div className="deploy-terminal-header">
                        <span>
                          <Icon name="terminal" size={18} />
                          {copy("Run on your server")}
                        </span>
                        <label className="deploy-install-toggle">
                          <input
                            type="checkbox"
                            checked={installed}
                            onChange={(event) => setInstalled(event.target.checked)}
                          />
                          <span>{copy("CLI already installed")}</span>
                        </label>
                      </div>
                      <div className="deploy-command">
                        <pre>
                          <code>{command}</code>
                        </pre>
                        <button
                          type="button"
                          onClick={() => copyText(command)}
                          aria-label={copy("Copy command")}
                          title={copy("Copy command")}
                        >
                          {copied === command ? (
                            <Icon name="check" size={18} />
                          ) : (
                            <Icon name="copy" size={18} />
                          )}
                        </button>
                      </div>
                      <p>{copy("Install OpenShip, then review this project in your dashboard.")}</p>
                    </section>
                    <section className="deploy-manage">
                      <span className="deploy-manage-icon">
                        <Icon name="cloud" size={22} aria-hidden />
                      </span>
                      <div>
                        <h2>{copy("Manage this server from Cloud")}</h2>
                        <p>{copy("Connect over SSH with an OpenShip Manage subscription.")}</p>
                      </div>
                      <a href={manageUrl} className="deploy-secondary">
                        {copy("Use OpenShip Manage")}
                        <Icon name="arrow-up-right" size={18} />
                      </a>
                    </section>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        {source && <DeployReadme source={source} copied={copied} onCopy={copyText} />}
        <p
          role="status"
          className={`deploy-copy-status${copyError ? " deploy-copy-status--error" : ""}`}
        >
          {copyError
            ? copy("Could not copy. Select and copy the text above.")
            : copied
              ? copy("Copied to clipboard.")
              : ""}
        </p>
      </main>
      <footer className="deploy-footer">
        <Link href="/" className="deploy-footer-brand">
          <span className="deploy-brand-mark" aria-hidden />
          {copy("OpenShip")}
        </Link>
        <span className="deploy-footer-separator" aria-hidden />
        <Link href="/support" className="deploy-text-link">
          <Icon name="help-circle" size={16} aria-hidden />
          {copy("Support")}
        </Link>
      </footer>
    </div>
  );
}
