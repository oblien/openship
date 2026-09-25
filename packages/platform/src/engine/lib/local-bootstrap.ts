import { AsyncLocalStorage } from "node:async_hooks";
import { env, runtimeTargetId } from "../config/env";

/** Public/CLI installations bootstrap with their host token, never anonymously. */
export function localBootstrapEnabled(): boolean {
  return !env.CLOUD_MODE && runtimeTargetId !== "cloud-saas" &&
    !env.OPENSHIP_PUBLIC_URL && !env.OPENSHIP_REQUIRE_AUTH &&
    (env.DEPLOY_MODE === "desktop" || env.OPENSHIP_ALLOW_ZERO_AUTH);
}

// Carry the HTTP peer authorization into Better Auth's database hook without
// trusting a request header or making a process-global first-signup exception.
const signupContext = new AsyncLocalStorage<boolean>();
export function withLocalSignup<T>(fn: () => T): T {
  return signupContext.run(true, fn);
}
export function isAuthorizedLocalSignup(): boolean {
  return localBootstrapEnabled() && signupContext.getStore() === true;
}
