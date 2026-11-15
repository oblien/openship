"use client";

import { PlatformProvider } from "@/context/PlatformContext";
import { MailAdminPanel } from "@/app/(dashboard)/emails/_components/admin/admin-panel";
import type { MailSetupStatus } from "@/lib/api";

// Real administration components with fictional domains and accounts. Mounted
// only by capture.mjs in its temporary, development-only route.
const status: MailSetupStatus = {
  active: false,
  serverId: "mail-preview",
  domain: "example.com",
  engine: { flavor: "container", running: true },
  steps: [],
};
const noop = () => {};

export default function Preview() {
  return (
    <PlatformProvider selfHosted deployMode="desktop" authMode="none" hostDomain="opsh.io">
      <div className="min-h-[760px] bg-background p-8 text-foreground" data-mail-capture>
        <header className="mb-7 flex items-center justify-between gap-4">
          <div className="text-2xl font-medium">OpenShip Mail</div>
          <span className="text-sm text-muted-foreground" dir="ltr">mail.example.com</span>
        </header>
        <MailAdminPanel status={status} serverId="mail-preview" onRefresh={noop} onForgotten={noop} />
      </div>
    </PlatformProvider>
  );
}
