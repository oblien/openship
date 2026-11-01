import { createRunBus } from "../../lib/run-bus";
export const clusterDatabaseBus = createRunBus<void>(() => false);
export const clusterDatabaseTopic = (org: string, projectId: string) =>
  JSON.stringify([org, projectId]);
export const notifyClusterDatabase = (org: string, projectId: string) =>
  clusterDatabaseBus.publish(clusterDatabaseTopic(org, projectId), undefined);
