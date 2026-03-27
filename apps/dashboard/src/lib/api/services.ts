import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Service {
  id: string;
  name: string;
  image: string | null;
  build: string | null;
  ports: string[] | null;
  dependsOn: string[] | null;
  environment: Record<string, string> | null;
  volumes: string[] | null;
  command: string | null;
  restart: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface ServiceContainer {
  serviceId: string;
  serviceName: string;
  containerId: string | null;
  status: string;
  ip: string | null;
  hostPort: number | null;
  imageRef: string | null;
}

export interface ServiceEnvVar {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  environment: string;
}

/* ------------------------------------------------------------------ */
/*  Services API (compose / multi-service projects)                   */
/* ------------------------------------------------------------------ */

export const servicesApi = {
  /** List all services for a project */
  list: (projectId: string | number) =>
    api.get<{ success: boolean; services: Service[] }>(
      endpoints.services.list(projectId),
    ),

  /** Get a single service */
  get: (projectId: string | number, serviceId: string) =>
    api.get<{ success: boolean; service: Service }>(
      endpoints.services.get(projectId, serviceId),
    ),

  /** Update a service configuration */
  update: (projectId: string | number, serviceId: string, data: Partial<Service>) =>
    api.patch<{ success: boolean; service: Service }>(
      endpoints.services.update(projectId, serviceId),
      data,
    ),

  /** Sync services from compose file parse result */
  sync: (
    projectId: string | number,
    services: Array<{
      name: string;
      image?: string;
      build?: string;
      dockerfile?: string;
      ports?: string[];
      dependsOn?: string[];
      environment?: Record<string, string>;
      volumes?: string[];
      command?: string;
      restart?: string;
    }>,
  ) =>
    api.post<{ success: boolean; services: Service[] }>(
      endpoints.services.sync(projectId),
      { services },
    ),

  /** Get active containers for all services */
  containers: (projectId: string | number) =>
    api.get<{ success: boolean; containers: ServiceContainer[] }>(
      endpoints.services.containers(projectId),
    ),

  /** Get environment variables for a service */
  getEnv: (projectId: string | number, serviceId: string, environment?: string) =>
    api.get<{ success: boolean; vars: ServiceEnvVar[] }>(
      `${endpoints.services.envGet(projectId, serviceId)}${environment ? `?environment=${environment}` : ""}`,
    ),

  /** Set environment variables for a service */
  setEnv: (
    projectId: string | number,
    serviceId: string,
    data: {
      environment: string;
      vars: Array<{ key: string; value: string; isSecret?: boolean }>;
    },
  ) =>
    api.put<{ success: boolean; count: number }>(
      endpoints.services.envSet(projectId, serviceId),
      data,
    ),
};
