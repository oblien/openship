import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TCreateProjectBody, TEnsureProjectBody, TUpdateProjectBody } from "./project-inputs";
import type { ProjectControlOperations } from "./project-controls";
import type { ProjectLocalOperations } from "./project-local";
import type { ProjectLogStreams } from "./project-logs";

const nullableString = () => Type.Union([Type.String(), Type.Null()]);
/** Public project fields. Provider-specific diagnostics may accompany these fields. */
export const ProjectSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  groupId: Type.String({ minLength: 1 }),
  name: Type.String(),
  slug: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  environmentName: Type.Optional(Type.String()),
  environmentSlug: Type.Optional(Type.String()),
  environmentType: Type.Optional(Type.String()),
  gitProvider: Type.Optional(nullableString()),
  gitOwner: Type.Optional(nullableString()),
  gitRepo: Type.Optional(nullableString()),
  gitBranch: Type.Optional(nullableString()),
  framework: Type.Optional(nullableString()),
  packageManager: Type.Optional(nullableString()),
  localPath: Type.Optional(nullableString()),
  serverId: Type.Optional(nullableString()),
  activeDeploymentId: Type.Optional(nullableString()),
  runtimeMode: Type.Optional(nullableString()),
  deployTarget: Type.Optional(nullableString()),
  source: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("cloud")])),
  buildCommand: Type.Optional(nullableString()),
  installCommand: Type.Optional(nullableString()),
  startCommand: Type.Optional(nullableString()),
  outputDirectory: Type.Optional(nullableString()),
  rootDirectory: Type.Optional(nullableString()),
  hasServer: Type.Optional(Type.Boolean()),
  hasBuild: Type.Optional(Type.Boolean()),
  autoDeploy: Type.Optional(Type.Boolean()),
  port: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
}, { additionalProperties: true });

export type Project = Static<typeof ProjectSchema>;
export const ProjectHomeSchema = Type.Object({
  success: Type.Literal(true),
  projects: Type.Array(ProjectSchema),
  numbers: Type.Object({
    total_projects: Type.Number(), total_active_projects: Type.Number(),
    total_deployments: Type.Number(), total_success_deployments: Type.Number(),
  }),
  otherOrgs: Type.Array(Type.Object({ organizationId: Type.String(), name: Type.String(), projectCount: Type.Number() })),
  cloudPartial: Type.Optional(Type.Boolean()),
});
export type ProjectHome = Static<typeof ProjectHomeSchema>;
export const isProjectHome = (value: unknown): value is ProjectHome => Value.Check(ProjectHomeSchema, value);
export type CreateProjectInput = TCreateProjectBody;
export type EnsureProjectInput = TEnsureProjectBody;
export type UpdateProjectInput = TUpdateProjectBody;
export const ListProjectsSchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});
export type ListProjectsInput = Static<typeof ListProjectsSchema>;
export interface ProjectPage { data: Project[]; total: number; page: number; perPage: number }
export interface EnsureProjectResult { success: boolean; project_id: string; created: boolean }
export interface ProjectOperations extends ProjectControlOperations, ProjectLocalOperations, ProjectLogStreams {
  getHome(): Promise<ProjectHome>;
  create(input: CreateProjectInput): Promise<Project>;
  ensure(input: EnsureProjectInput): Promise<EnsureProjectResult>;
  list(input?: ListProjectsInput): Promise<ProjectPage>;
  get(id: string): Promise<Project>;
  update(id: string, input: UpdateProjectInput): Promise<Project>;
}
export const isProject = (value: unknown): value is Project => Value.Check(ProjectSchema, value);
export const isProjectPage = (value: unknown): value is ProjectPage => Value.Check(Type.Object({
  data: Type.Array(ProjectSchema), total: Type.Number(), page: Type.Number(), perPage: Type.Number(),
}), value);
export const isEnsureProjectResult = (value: unknown): value is EnsureProjectResult => Value.Check(Type.Object({
  success: Type.Boolean(), project_id: Type.String({ minLength: 1 }), created: Type.Boolean(),
}), value);
