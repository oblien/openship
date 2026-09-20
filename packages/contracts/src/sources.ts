import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { BuildServiceInput } from "./deployment-inputs";
import { EnsureProjectBody } from "./project-inputs";
import { EnvRevealKeysSchema, type SourceScanOptions } from "./env-reveal";

export type CodeSource = { type: "directory"; path: string } | { type: "files"; files: Readonly<Record<string, string | Uint8Array>> };
export interface StageSourceInput { source: CodeSource; projectId?: string; name?: string; stack?: string; packageManager?: string }
export const StagedSourceSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }), expiresAt: Type.Integer({ minimum: 0 }),
});
export const FolderSessionResultSchema = Type.Object({
  ...StagedSourceSchema.properties,
  upload: Type.Object({
    url: Type.String({ minLength: 1 }), absoluteUrl: Type.String({ minLength: 1 }),
    method: Type.Literal("POST"), headers: Type.Record(Type.String(), Type.String()),
    requiresAuth: Type.Boolean(), withCredentials: Type.Boolean(),
  }),
});
export const SourceScanSchema = Type.Object({
  name: Type.String(), stack: Type.String(), projectType: Type.String(), packageManager: Type.String(),
  installCommand: Type.String(), buildCommand: Type.String(), startCommand: Type.String(), buildImage: Type.String(),
  outputDirectory: Type.String(), rootDirectory: Type.String(),
  port: Type.Optional(Type.Number()), productionPaths: Type.Optional(Type.Array(Type.String())),
  productionMode: Type.Optional(Type.String()), workloadType: Type.Optional(Type.String()), runtimeMode: Type.Optional(Type.String()),
  composePath: Type.Optional(Type.String()), volumes: EnsureProjectBody.properties.volumes,
  routing: EnsureProjectBody.properties.routingConfig,
  services: Type.Optional(Type.Array(Type.Object({
    ...BuildServiceInput.properties,
    commandArgv: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  }, { additionalProperties: true }))),
  monorepoWorkspace: EnsureProjectBody.properties.monorepoWorkspace,
  monorepoApps: EnsureProjectBody.properties.monorepoApps,
  configDiagnostics: Type.Optional(Type.Object({
    errors: Type.Array(Type.String()), warnings: Type.Array(Type.String()), wholeFile: Type.Optional(Type.Literal(true)),
  })),
}, { additionalProperties: true });
export type StagedSource = Static<typeof StagedSourceSchema>;
export type FolderSessionResult = Static<typeof FolderSessionResultSchema>;
export type SourceScan = Static<typeof SourceScanSchema>;
export const isStagedSource = (value: unknown): value is StagedSource => Value.Check(StagedSourceSchema, value);
export const isFolderSessionResult = (value: unknown): value is FolderSessionResult => Value.Check(FolderSessionResultSchema, value);
export const isSourceScan = (value: unknown): value is SourceScan => Value.Check(SourceScanSchema, value);
export const RevealSourceSchema = Type.Object({
  service: Type.String({ minLength: 1 }),
  keys: EnvRevealKeysSchema,
});
export interface SourceOperations {
  stage(input: StageSourceInput, options?: { signal?: AbortSignal; onStep?: (message: string) => void }): Promise<StagedSource>;
  open(input?: { projectId?: string; name?: string; stack?: string; packageManager?: string }): Promise<FolderSessionResult>;
  scan(id: string, options?: SourceScanOptions): Promise<SourceScan>;
  reveal(id: string, input: Static<typeof RevealSourceSchema>): Promise<Record<string, string>>;
}
