import { FolderSessionBody, ResourceIdSchema, RevealSourceSchema, SourceScanOptionsSchema, isRecord, isFolderSessionResult, isSourceScan, parseInput, type SourceOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { ApiError } from "./errors";

export async function requestSourceSession(http: HttpClient, input: Parameters<SourceOperations["open"]>[0] = {}, signal?: AbortSignal) {
  const result = await http.request("/projects/folder/session", { method: "POST", signal, body: JSON.stringify(parseInput(FolderSessionBody, input)) });
  if (!isFolderSessionResult(result)) throw new ApiError("Invalid upload session response", 502, result);
  return result;
}

export function createRemoteSourceOperations(http: HttpClient): SourceOperations {
  const path = (id: string) => "/projects/folder/scan/" + encodeURIComponent(parseInput(ResourceIdSchema, id));
  return Object.freeze({
    async stage(input, options) { return (await import("./sources")).stageRemoteSource(http, input, options); },
    open: input => requestSourceSession(http, input),
    async scan(id, options = {}) {
      const result = await http.request(path(id), { method: "POST", body: JSON.stringify(parseInput(SourceScanOptionsSchema, options)) });
      if (!isSourceScan(result)) throw new ApiError("Invalid source scan response", 502, result);
      return result;
    },
    async reveal(id, input) {
      const result = await http.request(path(id) + "/env-reveal", { method: "POST", body: JSON.stringify(parseInput(RevealSourceSchema, input)) });
      if (!isRecord(result) || !isRecord(result.environment) || Object.values(result.environment).some(value => typeof value !== "string")) throw new ApiError("Invalid source environment response", 502, result);
      return result.environment as Record<string, string>;
    },
  } satisfies SourceOperations);
}
