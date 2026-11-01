"use client";

import type { SecurityOverview } from "@repo/contracts";
import Link from "next/link";
import { useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { SecurityOverviewPanel } from "./SecurityOverviewPanel";

export function RuntimeSecurityDialog({
  overview,
  onClose,
  onChecked,
}: {
  overview: SecurityOverview;
  onClose: () => void;
  onChecked: () => void;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  return (
    <Modal isOpen onClose={onClose} width="760px" maxWidth="95vw" maxHeight="85vh">
      <div className="space-y-5 p-5 sm:p-6">
        <header className="space-y-2 pe-8">
          <h2 className="text-lg font-medium">{copy.title}</h2>
        </header>
        <SecurityOverviewPanel overview={overview} onChecked={onChecked} />
        <Link
          href="/monitoring?tab=security"
          onClick={onClose}
          className="inline-block text-sm underline underline-offset-4"
        >
          {copy.monitoring}
        </Link>
      </div>
    </Modal>
  );
}
