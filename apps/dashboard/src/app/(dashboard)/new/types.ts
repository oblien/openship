/**
 * Types for the Create Project flow.
 *
 * Steps:
 *   1. source   – pick where the code comes from (GitHub, upload, URL, template)
 *   2. configure – project name, framework, build settings, env vars
 *   3. target   – where to build & run (Oblien cloud, self-hosted)
 */

/* ── Step identifiers ───────────────────────────────────────────── */

export type Step = "source" | "configure" | "target";

/* ── Source types ────────────────────────────────────────────────── */

export type SourceKind = "github" | "upload" | "url" | "template";

export interface GitHubSource {
  kind: "github";
  owner: string;
  repo: string;
  branch: string;
  branches: string[];
  isPrivate: boolean;
  installationId?: number;
}

export interface UploadSource {
  kind: "upload";
  files: File[];
  rootName: string;
}

export interface UrlSource {
  kind: "url";
  gitUrl: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface TemplateSource {
  kind: "template";
  templateId: string;
  templateName: string;
  framework: string;
}

export type ProjectSource = GitHubSource | UploadSource | UrlSource | TemplateSource;

/* ── Build target ────────────────────────────────────────────────── */

export type BuildTarget = "cloud" | "self-hosted";

/* ── Environment variables ───────────────────────────────────────── */

export interface EnvVariable {
  key: string;
  value: string;
  visible: boolean;
}

/* ── Full project configuration ──────────────────────────────────── */

export interface ProjectConfig {
  name: string;
  framework: string;
  buildCommand: string;
  installCommand: string;
  outputDirectory: string;
  startCommand: string;
  rootDirectory: string;
  port: number;
  envVars: EnvVariable[];
  domain: string;
  customDomain: string;
}

/* ── Wizard state ────────────────────────────────────────────────── */

export interface NewProjectState {
  step: Step;
  source: ProjectSource | null;
  config: ProjectConfig;
  target: BuildTarget;
}

/* ── Defaults ────────────────────────────────────────────────────── */

export const DEFAULT_CONFIG: ProjectConfig = {
  name: "",
  framework: "static",
  buildCommand: "",
  installCommand: "npm install",
  outputDirectory: ".",
  startCommand: "",
  rootDirectory: "",
  port: 3000,
  envVars: [],
  domain: "",
  customDomain: "",
};
