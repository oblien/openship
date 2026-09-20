import type { AuditDependencies } from "../../../audit";
import * as service from "./audit.service";
export const auditDependencies: AuditDependencies = { collection: service };
