/**
 * Supervisor barrel exports.
 */
export type { ProcessSupervisor, SupervisorDeployOpts } from "./types";
export { SystemdSupervisor } from "./systemd";
export { NohupSupervisor } from "./nohup";
export { detectSupervisor } from "./detect";
