/**
 * GhCliSource — the local gh-CLI control surface. ZERO App/cloud knowledge.
 *
 * Thin wrapper over the github.local-auth primitives + the pure mappers. It is
 * a SUB-source: LocalGitHubSource (the merge) composes one of these for the
 * gh-first listing + local-clone token. It is NOT a full GitHubSource on its
 * own.
 *
 * Dynamically imported ONLY in non-CLOUD_MODE (see ./index.ts `maybeGhCli`), so
 * the gh subprocess / `github.local-auth` code path never loads on the SaaS.
 * github.local-auth also self-guards to null/`available:false` in CLOUD_MODE as
 * belt-and-suspenders.
 */

import {
  getLocalGhToken,
  getLocalGhStatus,
  listLocalGhRepos,
  listLocalGhOrgs,
} from "../github.local-auth";
import { mapRepositories } from "./mappers";
import type { LocalGhStatus } from "../github.local-auth";
import type {
  GitHubRepository,
  MappedAccount,
  MappedRepository,
} from "../github.types";

/** Alias, not a re-declaration: this shape carries `method` + `problem`, and a
 *  hand-mirrored copy here is exactly how the probe's method got dropped before
 *  it reached the wire. */
export type GhCliStatus = LocalGhStatus;

export class GhCliSource {
  constructor(private readonly userId: string) {}

  /** Raw local gh token (or null). */
  token(): Promise<string | null> {
    return getLocalGhToken();
  }

  /** gh CLI auth status + profile. */
  status(): Promise<GhCliStatus> {
    return getLocalGhStatus();
  }

  /** Every repo the gh user can see (owner + collaborator + org member). */
  async listAllRepos(): Promise<MappedRepository[]> {
    const raw = await listLocalGhRepos(this.userId);
    return mapRepositories(Array.isArray(raw) ? (raw as GitHubRepository[]) : []);
  }

  /** Repos for a specific owner, filtered from the affiliation list. */
  async listReposForOwner(owner?: string): Promise<MappedRepository[]> {
    const all = await this.listAllRepos();
    if (!owner) return all;
    const target = owner.toLowerCase();
    return all.filter(
      (r) => (r.full_name.split("/")[0] ?? "").toLowerCase() === target,
    );
  }

  /**
   * The gh user + every org they belong to — for the owner picker. Tagged
   * source: "cli" ("Local only"), incl. orgs with no App installation.
   */
  async listOwners(): Promise<MappedAccount[]> {
    const out: MappedAccount[] = [];
    const seen = new Set<string>();

    const st = await getLocalGhStatus();
    if (st.available && st.login) {
      out.push({
        login: st.login,
        id: st.id ?? 0,
        avatar_url: st.avatar_url ?? "",
        type: "User",
        source: "cli",
      });
      seen.add(st.login.toLowerCase());
    }
    for (const org of await listLocalGhOrgs(this.userId)) {
      if (seen.has(org.login.toLowerCase())) continue;
      out.push({
        login: org.login,
        id: org.id,
        avatar_url: org.avatar_url,
        type: "Organization",
        source: "cli",
      });
      seen.add(org.login.toLowerCase());
    }
    return out;
  }
}
