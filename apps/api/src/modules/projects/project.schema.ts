import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  repo: z.string().url().optional(),
  framework: z.enum(["nextjs", "node", "static", "docker"]).optional(),
});

export const updateProjectSchema = createProjectSchema.partial();
