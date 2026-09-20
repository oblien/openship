import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CreateProjectBody } from "./project-inputs";
import { ProjectSchema, type Project } from "./projects";
import { SourceScanSchema } from "./sources";
import { SourceScanOptionsSchema } from "./env-reveal";

export const ScanLocalProjectBody = Type.Object({
  ...SourceScanOptionsSchema.properties,
  path: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const ImportLocalProjectBody = Type.Object({
  ...CreateProjectBody.properties,
  localPath: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const LocalProjectScanSchema = Type.Object({ ...SourceScanSchema.properties, success: Type.Boolean(), path: Type.String() });
export const LocalProjectsSchema = Type.Object({ success: Type.Boolean(), projects: Type.Array(ProjectSchema) });
export type ImportLocalProjectInput = Static<typeof ImportLocalProjectBody>;
export type LocalProjectScan = Static<typeof LocalProjectScanSchema>;
export type LocalProjects = Static<typeof LocalProjectsSchema>;
export const isLocalProjectScan = (value: unknown): value is LocalProjectScan => Value.Check(LocalProjectScanSchema, value);
export const isLocalProjects = (value: unknown): value is LocalProjects => Value.Check(LocalProjectsSchema, value);

export interface ProjectLocalOperations {
  scanLocal(input: Static<typeof ScanLocalProjectBody>): Promise<LocalProjectScan>;
  importLocal(input: ImportLocalProjectInput): Promise<Project>;
  listLocal(): Promise<LocalProjects>;
}
