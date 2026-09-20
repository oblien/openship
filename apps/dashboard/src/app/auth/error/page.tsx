"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { authErrorDetails } from "@/lib/auth-error";

function AuthErrorContent() {
  const searchParams = useSearchParams();
  const details = authErrorDetails(
    searchParams.get("error"),
    searchParams.get("error_description"),
  );

  return (
    <AuthShell>
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">Authorization failed</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{details.message}</p>
      </div>

      <div className="mt-5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-center">
        <code className="text-xs text-muted-foreground">{details.code}</code>
      </div>

      <Button asChild className="mt-6 w-full">
        <Link href="/">Return to OpenShip</Link>
      </Button>
    </AuthShell>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading authorization error…
          </div>
        </AuthShell>
      }
    >
      <AuthErrorContent />
    </Suspense>
  );
}
