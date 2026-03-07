import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  AI / Sessions API                                                 */
/* ------------------------------------------------------------------ */

export const aiApi = {
  /** List AI chat sessions */
  listSessions: (params: {
    limit: number;
    agent_id?: string;
    namespace?: string;
  }) =>
    api.get<any>(endpoints.ai.sessionList, {
      params: {
        limit: params.limit,
        agent_id: params.agent_id,
        namespace: params.namespace ?? "self",
      },
    }),
};
