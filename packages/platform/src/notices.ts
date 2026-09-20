import {
  NoticeCollectionSchemas, OperatorNoticeCollectionSchemas, OperatorNoticeResourceSchemas,
  ResourceIdSchema, parseInput, type CreateNoticeInput, type NoticeOperations, type OperatorNoticeOperations,
} from "@repo/contracts";
import { AppError } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import { presentOperationOutput, type PlatformScopedOperations } from "./resource-operations";

export interface NoticeDependencies { list(): Promise<unknown> }
export interface OperatorNoticeDependencies {
  listAll(): Promise<unknown>;
  create(input: CreateNoticeInput): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}
export type PlatformNoticeOperations = PlatformScopedOperations<typeof NoticeCollectionSchemas>;

export function createPublicNoticeOperations(deps?: NoticeDependencies): NoticeOperations {
  return Object.freeze({ async list() {
    if (!deps) throw new AppError("Notices are not configured", 501, "CAPABILITY_UNAVAILABLE");
    return presentOperationOutput(NoticeCollectionSchemas.list, await deps.list(), "notices.list") as Awaited<ReturnType<NoticeOperations["list"]>>;
  } });
}

/** These are intentionally public announcements; they carry no tenant data or mutation authority. */
export function createNoticeOperations(_authorization: Authorization, deps?: NoticeDependencies): PlatformNoticeOperations {
  const notices = createPublicNoticeOperations(deps);
  return Object.freeze({ async list(context: ExecutionContext) { return { context, data: await notices.list() }; } });
}

/** Only the trusted composition root receives this capability. HTTP verifies its
 * internal credential; an owned runtime explicitly enables host administration. */
export function createOperatorNoticeOperations(deps: OperatorNoticeDependencies): OperatorNoticeOperations {
  return Object.freeze({
    async listAll() {
      return presentOperationOutput(OperatorNoticeCollectionSchemas.listAll, await deps.listAll(), "operator.notices.listAll") as Awaited<ReturnType<OperatorNoticeOperations["listAll"]>>;
    },
    async create(command: CreateNoticeInput) {
      const input = parseInput(OperatorNoticeCollectionSchemas.create.input, command);
      return presentOperationOutput(OperatorNoticeCollectionSchemas.create, await deps.create(input), "operator.notices.create") as Awaited<ReturnType<OperatorNoticeOperations["create"]>>;
    },
    async remove(value: string) {
      const id = parseInput(ResourceIdSchema, value);
      return presentOperationOutput(OperatorNoticeResourceSchemas.remove, await deps.remove(id), "operator.notices.remove") as { success: true };
    },
  });
}
