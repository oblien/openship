"use client";

import { Logo } from "@/components/logo";
import { UpdateCenter } from "@/components/updates/UpdateCenter";
import { useSearchParams } from "next/navigation";
import { SecurityAdvisorySettings } from "@/app/(dashboard)/settings/_components/SecurityAdvisorySettings";
import { Icon } from "@repo/ui/icons";
import Link from "next/link";
import { IssuesView } from "@/app/(dashboard)/issues/IssuesView";
import { PlatformProvider } from "@/context/PlatformContext";

/** Real root update banner and dialog; capture.mjs supplies synthetic API responses. */
export default function Preview() {
  const settings = useSearchParams().get("settings") === "1";
  const monitoring = useSearchParams().get("monitoring") === "1";
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl" data-security-capture>
        <header className="flex flex-wrap items-center justify-between gap-4 px-6 pt-8">
          <div className="flex items-center gap-3 text-lg font-medium">
            <Logo size={28} /> OpenShip
          </div>
          <p className="text-xs text-muted-foreground">Preview · sample application data</p>
          <Link href="/security-advisory-capture?monitoring=1&tab=security">
            Preview monitoring
          </Link>
        </header>
        <UpdateCenter />
        <section className="space-y-6 px-6 py-8">
          {monitoring ? (
            <PlatformProvider selfHosted={false} authMode="cloud">
              <IssuesView />
            </PlatformProvider>
          ) : settings ? (
            <SecurityAdvisorySettings />
          ) : (
            <>
              <div>
                <h1 className="text-2xl font-medium">Home</h1>
                <p className="mt-2 text-sm text-muted-foreground">Your workspace at a glance.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  ["Projects", "2"],
                  ["Running services", "3"],
                  ["Servers", "1"],
                ].map(([label, count]) => (
                  <div key={label} className="space-y-3 rounded-2xl bg-card p-5">
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <p className="text-2xl font-medium">{count}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl bg-card p-5">
                <h2 className="mb-5 text-base font-medium">Projects</h2>
                {["Commerce API", "Storefront"].map((name) => (
                  <div key={name} className="flex items-center justify-between gap-3 py-4">
                    <div className="flex items-center gap-3">
                      <Icon name="folder" className="size-5 text-muted-foreground" />
                      <span className="text-sm">{name}</span>
                    </div>
                    <span className="text-sm text-success">Running</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
