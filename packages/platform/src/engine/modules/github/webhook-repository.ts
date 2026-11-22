import type { GitRepositoryRef } from "@repo/core";

/** full_name is present on every repository event and identifies the signing key. */
export function webhookRepository(payload: unknown): GitRepositoryRef | undefined {
  const repo = (
    payload as {
      repository?: { full_name?: unknown; name?: string; owner?: { login?: string } };
    } | null
  )?.repository;
  if (typeof repo?.full_name !== "string") return;
  const [namespace, name, ...extra] = repo.full_name.split("/");
  if (!namespace || !name || extra.length) return;
  if (
    repo.name !== undefined &&
    (typeof repo.name !== "string" || repo.name.toLowerCase() !== name.toLowerCase())
  )
    return;
  const login = repo.owner?.login;
  if (
    login !== undefined &&
    (typeof login !== "string" || login.toLowerCase() !== namespace.toLowerCase())
  )
    return;
  return { provider: "github", namespace, name };
}
