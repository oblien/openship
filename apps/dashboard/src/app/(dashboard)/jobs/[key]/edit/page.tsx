"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { jobsApi, getApiErrorMessage, type JobView } from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { JobForm } from "@/components/jobs/JobForm";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

export default function EditJobPage() {
  const { t } = useI18n();
  const j = t.jobs;
  const router = useRouter();
  const params = useParams();
  const key = decodeURIComponent(String(params.key));
  const { selfHosted } = usePlatform();
  const { showToast } = useToast();

  const [job, setJob] = useState<JobView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await jobsApi.get(key);
      setJob(res.data);
    } catch (err) {
      showToast(getApiErrorMessage(err, j.loadFailed), "error", j.toast.title);
    } finally {
      setLoading(false);
    }
  }, [key, j.loadFailed, j.toast.title, showToast]);

  useEffect(() => {
    if (selfHosted) void load();
    else router.replace("/jobs");
  }, [selfHosted, load, router]);

  const backToDetail = () => router.push(`/jobs/${encodeURIComponent(key)}`);

  return (
    <PageContainer>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={backToDetail} className="flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-muted">
          <UiIcon name="arrow-left" className="size-4 text-muted-foreground rtl:rotate-180" />
        </button>
        <h1 className="truncate text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
          {j.edit.title}{job ? ` · ${job.label}` : ""}
        </h1>
      </div>

      {loading || !job ? (
        <div className="flex items-center justify-center py-20"><UiIcon name="spinner" className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <JobForm
          job={job}
          onCancel={backToDetail}
          onSaved={() => {
            showToast(j.toast.saved2, "success", j.toast.title);
            backToDetail();
          }}
        />
      )}
    </PageContainer>
  );
}
