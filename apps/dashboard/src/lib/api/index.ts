/**
 * @module @/lib/api
 *
 * Centralised API layer for the Openship dashboard.
 *
 * Usage:
 *   import { projectsApi, deployApi, githubApi } from "@/lib/api";
 *   const { projects, numbers } = await projectsApi.getHome();
 */

/* --- Low-level client (rarely needed directly) -------------------- */
export { api, ApiError, isAbortError, isNetworkError, setNetworkErrorHandler } from "./client";
export type { RequestOptions } from "./client";

/* --- Endpoint registry (single source of truth for paths) --------- */
export { endpoints } from "./endpoints";

/* --- Domain services ---------------------------------------------- */
export { projectsApi } from "./projects";
export { deployApi } from "./deploy";
export { githubApi } from "./github";
export { iconsApi } from "./icons";
export { aiApi } from "./ai";
export { sandboxApi } from "./sandbox";

/* --- Auth helpers -------------------------------------------------- */
export { getAuthToken } from "./auth";
