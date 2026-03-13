export type Step = "source" | "configure" | "target";

export type ProjectSource =
  | { kind: "github"; owner: string; repo: string; branch: string }
  | { kind: "url"; owner: string; repo: string }
  | { kind: "local"; path: string; name: string }
  | { kind: "template"; templateName: string; framework: string }
  | { kind: "upload"; rootName: string };

export interface NewProjectState {
  step: Step;
  source: ProjectSource | null;
  target: "cloud" | "self-hosted";
}
