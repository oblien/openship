"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import { MigrationWizard } from "@/components/migration/MigrationWizard";

export default function MigrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  return (
    <PageContainer>
      <MigrationWizard
        variant="tab"
        initialRunId={id}
        onClose={() => router.push("/library")}
        onBack={() => router.push("/library")}
      />
    </PageContainer>
  );
}
