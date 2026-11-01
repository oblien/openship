import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useState, useEffect, useRef } from "react";
import { projectsApi } from "@/lib/api";
import { type Project } from "@/constants/mock";
import { useCloudResourceKey } from "@/context/CloudResourceContext";

interface DashboardNumbers {
  total_active_projects?: number;
  total_deployments?: number;
  total_success_deployments?: number;
  total_failed_deployments?: number;
}

/**
 * Surfaced from the API when the active org has zero visible projects.
 * Lets the dashboard show a "your projects are in [Other Org]" CTA
 * instead of just an empty state — the common "I deployed but it's
 * not here" symptom of a session that switched orgs.
 */
export interface OtherOrgHint {
  organizationId: string;
  name: string;
  projectCount: number;
}

export function useDashboardHome(initialData?: any) {
  const resourceKey = useCloudResourceKey();
  const [owner, setOwner] = useState(resourceKey);
  const [projects, setProjects] = useState<Project[]>(initialData?.projects || []);
  const [numbers, setNumbers] = useState<DashboardNumbers>(initialData?.numbers || {});
  const [otherOrgs, setOtherOrgs] = useState<OtherOrgHint[]>(initialData?.otherOrgs || []);
  const [loading, setLoading] = useState(!initialData);
  const initRef = useRef(false);

  useEffect(() => {
    if (!initRef.current && initialData) {
      initRef.current = true;
      return;
    }
    initRef.current = true;
    let active = true;
    setOwner(resourceKey);
    setProjects([]);
    setNumbers({});
    setOtherOrgs([]);
    setLoading(true);

    (async () => {
      try {
        const res = await projectsApi.getHome();
        if (!active) return;
        setNumbers(res.numbers ?? {});
        if (res.success && Array.isArray(res.projects)) {
          setProjects(res.projects);
        }
        const maybeOther = (res as unknown as { otherOrgs?: OtherOrgHint[] }).otherOrgs;
        if (Array.isArray(maybeOther)) {
          setOtherOrgs(maybeOther);
        }
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/hooks/useDashboardHome");
        /* silent */
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [resourceKey]); // SSR data only seeds the first view; connection changes fetch a fresh account inventory.

  const removeProject = (id: string) => setProjects(current => current.filter(project => project.id !== id));
  const current = owner === resourceKey;
  return { projects: current ? projects : [], numbers: current ? numbers : {}, otherOrgs: current ? otherOrgs : [], loading: !current || loading, removeProject };
}
