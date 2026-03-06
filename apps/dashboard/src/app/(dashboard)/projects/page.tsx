"use client";

import { PageHeader } from "@/components/page-header";

export default function ProjectsPage() {
  return (
    <>
      <PageHeader pageKey="projects" />
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No projects yet. Create your first project to get started.
        </p>
      </div>
    </>
  );
}
