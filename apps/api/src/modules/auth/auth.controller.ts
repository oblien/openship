import type { Context } from "hono";
import { registerSchema, loginSchema, refreshSchema } from "./auth.schema";
import * as authService from "./auth.service";

/**
 * POST /api/auth/register
 * Body: { email, password, name? }
 */
export async function register(c: Context) {
  const body = await c.req.json();
  const data = registerSchema.parse(body);
  const result = await authService.register(data);
  return c.json({ data: result }, 201);
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function login(c: Context) {
  const body = await c.req.json();
  const { email, password } = loginSchema.parse(body);
  const result = await authService.login(email, password);
  return c.json({ data: result });
}

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 */
export async function refresh(c: Context) {
  const body = await c.req.json();
  const { refreshToken } = refreshSchema.parse(body);
  const result = await authService.refresh(refreshToken);
  return c.json({ data: result });
}

/**
 * POST /api/auth/logout
 * Body: { refreshToken }
 * Requires: Bearer token
 */
export async function logout(c: Context) {
  const body = await c.req.json();
  const { refreshToken } = refreshSchema.parse(body);
  await authService.logout(refreshToken);
  return c.json({ data: { message: "Logged out" } });
}

/**
 * GET /api/auth/me
 * Requires: Bearer token
 */
export async function me(c: Context) {
  const userId = c.get("userId") as string;
  const user = await authService.me(userId);
  return c.json({ data: { user } });
}
