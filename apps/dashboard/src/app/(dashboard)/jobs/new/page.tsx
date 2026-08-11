"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { JobForm } from "@/components/jobs/JobForm";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

export default function NewJobPage() {
  const { t } = useI18n();
  const j = t.jobs;
  const router = useRouter();
  const { selfHosted } = usePlatform();
  const { showToast } = useToast();

  useEffect(() => {
    if (!selfHosted) router.replace("/jobs");
  }, [selfHosted, router]);

  return (
    <PageContainer>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => router.push("/jobs")} className="flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-muted">
          <ArrowLeft className="size-4 text-muted-foreground rtl:rotate-180" />
        </button>
        <div>
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>{j.create.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{j.customEmpty.desc}</p>
        </div>
      </div>

      <JobForm
        onCancel={() => router.push("/jobs")}
        onSaved={(saved) => {
          showToast(j.toast.created, "success", j.toast.title);
          router.push(`/jobs/${encodeURIComponent(saved.key)}`);
        }}
      />
    </PageContainer>
  );
}
