import { useState, useEffect, useRef } from "react";
import { projectsApi } from "@/lib/api";
import { type Project } from "@/constants/mock";

interface DashboardNumbers {
  total_active_projects?: number;
  total_deployments?: number;
  total_success_deployments?: number;
  total_failed_deployments?: number;
}

export function useDashboardHome(initialData?: any) {
  const [projects, setProjects] = useState<Project[]>(initialData?.projects || []);
  const [numbers, setNumbers] = useState<DashboardNumbers>(initialData?.numbers || {});
  const [loading, setLoading] = useState(!initialData);
  const initRef = useRef(false);

  useEffect(() => {
    // If we already have SSR initialData, no need to fetch!
    if (initialData) return;
    
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        const res = await projectsApi.getHome();
        setNumbers(res.numbers ?? {});
        if (res.success && Array.isArray(res.projects)) {
          setProjects(res.projects);
        }
      } catch {
        /* silent */
      } finally {
        setLoading(false);
      }
    })();
  }, [initialData]);

  return { projects, numbers, loading };
}
