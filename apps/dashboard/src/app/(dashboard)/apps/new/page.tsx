"use client";

import { AppCatalog } from "@/components/apps/AppCatalog";
import { PageContainer } from "@/components/ui/PageContainer";

export default function NewAppPage() {
  return (
    <PageContainer outerClassName="pb-20">
      <AppCatalog />
    </PageContainer>
  );
}
