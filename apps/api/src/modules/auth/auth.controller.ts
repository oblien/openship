import type { Context } from "hono";

export async function register(c: Context) {
  // TODO: Implement registration with auth.service
  return c.json({ message: "register" }, 201);
}

export async function login(c: Context) {
  // TODO: Implement login
  return c.json({ message: "login" });
}

export async function logout(c: Context) {
  // TODO: Implement logout
  return c.json({ message: "logout" });
}

export async function refresh(c: Context) {
  // TODO: Implement token refresh
  return c.json({ message: "refresh" });
}

export async function me(c: Context) {
  // TODO: Return current user from JWT
  return c.json({ message: "me" });
}
