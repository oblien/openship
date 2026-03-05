import { Hono } from "hono";
import * as authController from "./auth.controller";

export const authRoutes = new Hono();

authRoutes.post("/register", authController.register);
authRoutes.post("/login", authController.login);
authRoutes.post("/logout", authController.logout);
authRoutes.post("/refresh", authController.refresh);
authRoutes.get("/me", authController.me);
