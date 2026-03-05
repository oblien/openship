import { Hono } from "hono";
import * as deploymentController from "./deployment.controller";

export const deploymentRoutes = new Hono();

deploymentRoutes.get("/", deploymentController.list);
deploymentRoutes.post("/", deploymentController.create);
deploymentRoutes.get("/:id", deploymentController.getById);
deploymentRoutes.get("/:id/logs", deploymentController.logs);
deploymentRoutes.post("/:id/rollback", deploymentController.rollback);
deploymentRoutes.post("/:id/cancel", deploymentController.cancel);
