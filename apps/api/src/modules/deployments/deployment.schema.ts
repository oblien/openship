import { z } from "zod";

export const createDeploymentSchema = z.object({
  projectId: z.string().uuid(),
  branch: z.string().default("main"),
  environment: z.enum(["production", "preview"]).default("production"),
});
