import { Hono } from "hono";
import * as projectController from "./project.controller";

export const projectRoutes = new Hono();

projectRoutes.get("/", projectController.list);
projectRoutes.post("/", projectController.create);
projectRoutes.get("/:id", projectController.getById);
projectRoutes.patch("/:id", projectController.update);
projectRoutes.delete("/:id", projectController.remove);
