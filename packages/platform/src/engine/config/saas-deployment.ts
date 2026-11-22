import { runtimeTargetId } from "@repo/core";
import { env } from "./env";

/** Auth and system mail recognize a production SaaS target even if CLOUD_MODE is missing. */
export const isSaasDeployment = env.CLOUD_MODE || runtimeTargetId === "cloud-saas";
