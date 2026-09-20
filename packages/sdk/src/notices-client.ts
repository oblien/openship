import { NoticeCollectionSchemas, OperatorNoticeCollectionSchemas, OperatorNoticeResourceSchemas, type NoticeOperations, type OperatorNoticeOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteNoticeOperations(http: HttpClient): NoticeOperations {
  return createRemoteScopedOperations(http, NoticeCollectionSchemas, { list: { method: "GET", path: () => "/notices" } });
}
export function createRemoteOperatorNoticeOperations(http: HttpClient): OperatorNoticeOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, OperatorNoticeCollectionSchemas, {
      listAll: { method: "GET", path: () => "/notices/all", envelope: "notices" },
      create: { method: "POST", path: () => "/notices", envelope: "notice" },
    }),
    ...createRemoteResourceOperations(http, OperatorNoticeResourceSchemas, { remove: { method: "DELETE", path: id => `/notices/${encodeURIComponent(id)}` } }),
  });
}
