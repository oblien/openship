import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Icons API                                                         */
/* ------------------------------------------------------------------ */

export const iconsApi = {
  /** Search icons by query string with pagination */
  search: (query: string, offset = 0, limit = 100) =>
    api.post<any>(endpoints.icons.search, { query, offset, limit }),
};
