"use client";

import { Suspense } from "react";
import { Icon } from "@repo/ui/icons";
import { AuthShell } from "@/components/auth-shell";
import { TwoFactorChallenge } from "./challenge";

export default function TwoFactorPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <Icon name="spinner" className="mx-auto size-6 animate-spin" />
        </AuthShell>
      }
    >
      <TwoFactorChallenge />
    </Suspense>
  );
}
