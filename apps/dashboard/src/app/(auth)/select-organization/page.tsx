"use client";

/**
 * Entry-point organization picker.
 *
 * Shown after login when the user belongs to more than one organization,
 * so they can pick which workspace to enter. Modeled on Cloudflare's
 * "select an account" screen — a single centered card with a scrollable
 * list of orgs, each row clickable.
 *
 * Wired to Better Auth's organization plugin:
 *   list()                                     → all orgs the user belongs to
 *   getFullOrganization({ organizationId })    → role + memberCount per org
 *   setActive({ organizationId })              → switch active org cookie
 *
 * Same Proxy-ref caveat as account-switcher.tsx / TeamTab — capture the
 * org client at module scope so its identity is stable.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient, signOut } from "@/lib/auth-client";
import { setActiveOrganizationId } from "@/lib/api/client";
import { AuthShell } from "@/components/auth-shell";
import { Building2, ChevronRight, Loader2, Plus, User } from "lucide-react";

type MemberRole = "owner" | "admin" | "member" | "restricted";

interface OrgRow {
  id: string;
  name: string;
  slug?: string | null;
  logo?: string | null;
  isTeam?: boolean | null;
}

interface OrgFull {
  id: string;
  name: string;
  isTeam?: boolean | null;
  members?: Array<{ userId: string; role: MemberRole }>;
}

/**
 * Module-level singleton — Better Auth's React client wraps the
 * organization plugin in a Proxy whose property accesses return fresh
 * references on every read, which explodes useEffect deps into infinite
 * loops if captured inside the component body. See TeamTab.tsx for the
 * full explanation.
 */
const orgClient = (authClient as unknown as {
  organization: {
    list: () => Promise<{ data?: OrgRow[] }>;
    setActive: (opts: { organizationId: string }) => Promise<{
      error?: { message?: string };
    }>;
    getFullOrganization: (opts?: { organizationId?: string }) => Promise<{
      data?: OrgFull | null;
    }>;
  };
}).organization;

interface DecoratedOrg {
  id: string;
  name: string;
  isTeam: boolean;
  role: MemberRole | null;
  memberCount: number;
}

function roleLabel(role: MemberRole | null): string {
  if (!role) return "Member";
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "member":
      return "Member";
    case "restricted":
      return "Restricted";
  }
}

export default function SelectOrganizationPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [orgs, setOrgs] = useState<DecoratedOrg[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const listRes = await orgClient.list();
        const list = listRes.data ?? [];

        // Edge cases: no orgs (shouldn't happen — personal org auto-created
        // on signup) and single-org (this page should be unreachable, but
        // defensive: silently switch + redirect).
        if (list.length === 0) {
          if (!cancelled) setLoading(false);
          return;
        }
        if (list.length === 1) {
          const only = list[0];
          await orgClient.setActive({ organizationId: only.id });
          setActiveOrganizationId(only.id);
          router.replace("/");
          return;
        }

        // Resolve role + member count per-org in parallel. Better Auth's
        // getFullOrganization accepts an explicit organizationId and
        // returns the member list without flipping the session's active
        // org — exactly what we need here.
        const fulls = await Promise.all(
          list.map((o) =>
            orgClient
              .getFullOrganization({ organizationId: o.id })
              .then((r) => r.data ?? null)
              .catch(() => null),
          ),
        );

        // Resolve current user id by finding the userId that appears in
        // every org's member list. The caller is a member of every org
        // they belong to, so their userId is the intersection across
        // payloads — robust against shared members between orgs.
        let currentUserId: string | null = null;
        const candidateCounts = new Map<string, number>();
        let resolvedFulls = 0;
        for (const f of fulls) {
          if (!f?.members) continue;
          resolvedFulls += 1;
          for (const m of f.members) {
            candidateCounts.set(
              m.userId,
              (candidateCounts.get(m.userId) ?? 0) + 1,
            );
          }
        }
        for (const [uid, count] of candidateCounts) {
          if (count === resolvedFulls && resolvedFulls > 0) {
            currentUserId = uid;
            break;
          }
        }

        const decorated: DecoratedOrg[] = list.map((o, i) => {
          const full = fulls[i];
          const me = currentUserId
            ? full?.members?.find((m) => m.userId === currentUserId)
            : undefined;
          return {
            id: o.id,
            name: o.name,
            isTeam: full?.isTeam === true || o.isTeam === true,
            role: (me?.role as MemberRole | undefined) ?? null,
            memberCount: full?.members?.length ?? 0,
          };
        });

        if (!cancelled) {
          setOrgs(decorated);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not load your workspaces.",
          );
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handlePick = async (orgId: string) => {
    if (picking) return;
    setPicking(orgId);
    try {
      const res = await orgClient.setActive({ organizationId: orgId });
      if (res.error) {
        setError(res.error.message ?? "Failed to switch organization.");
        setPicking(null);
        return;
      }
      setActiveOrganizationId(orgId);
      router.push("/");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to switch organization.",
      );
      setPicking(null);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } finally {
      router.push("/login");
    }
  };

  const sorted = useMemo(
    () =>
      [...orgs].sort((a, b) => {
        // Personal first, then team orgs, then alphabetical.
        if (a.isTeam !== b.isTeam) return a.isTeam ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
    [orgs],
  );

  // No orgs (defensive). Personal org is auto-created on signup so this
  // should be unreachable in practice — render a settling spinner.
  if (!loading && orgs.length === 0) {
    return (
      <AuthShell maxWidth="max-w-[440px]">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            Setting up your workspace...
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell maxWidth="max-w-[440px]">
      <div className="mb-6">
        <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.03em] text-foreground">
          Select an organization
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick which workspace to enter.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul className="max-h-[440px] divide-y divide-border overflow-y-auto">
            {sorted.map((o) => {
              const Icon = o.isTeam ? Building2 : User;
              const isPicking = picking === o.id;
              const disabled = picking !== null && !isPicking;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => handlePick(o.id)}
                    disabled={disabled || isPicking}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-start transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                      <Icon className="size-5 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-foreground">
                        {o.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          {roleLabel(o.role)}
                        </span>
                        <span className="mx-1.5 opacity-50">·</span>
                        {o.memberCount}{" "}
                        {o.memberCount === 1 ? "member" : "members"}
                      </p>
                    </div>
                    {isPicking ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Link
        href="/settings?tab=team"
        className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
      >
        <Plus className="size-4" />
        Create new organization
      </Link>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        Not you?{" "}
        <button
          type="button"
          onClick={handleSignOut}
          className="font-medium text-foreground transition-colors hover:underline"
        >
          Sign out
        </button>
      </p>
    </AuthShell>
  );
}
