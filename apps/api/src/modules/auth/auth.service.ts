import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { randomBytes } from "crypto";
import { db } from "@repo/db";
import { env } from "../../config/env";
import {
  ConflictError,
  UnauthorizedError,
  NotFoundError,
} from "@repo/core";
import type { AuthUser, RegisterInput } from "./auth.schema";

// ─── Constants ───────────────────────────────────────────────────────────────

const SALT_ROUNDS = 12;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toAuthUser(user: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  createdAt: Date;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

function signAccessToken(userId: string): string {
  const options: SignOptions = {
    expiresIn: env.JWT_EXPIRES_IN as unknown as SignOptions["expiresIn"],
  };
  return jwt.sign({ sub: userId }, env.JWT_SECRET, options);
}

function generateRefreshToken(): string {
  return randomBytes(40).toString("hex");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a new user account.
 * Returns the user + access/refresh tokens.
 */
export async function register(data: RegisterInput) {
  const existing = await db.user.findUnique({
    where: { email: data.email },
  });

  if (existing) {
    throw new ConflictError("A user with this email already exists");
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  const user = await db.user.create({
    data: {
      email: data.email,
      passwordHash,
      name: data.name ?? null,
    },
  });

  const tokens = await createTokenPair(user.id);

  return { user: toAuthUser(user), tokens };
}

/**
 * Authenticate with email + password.
 * Returns the user + access/refresh tokens.
 */
export async function login(email: string, password: string) {
  const user = await db.user.findUnique({ where: { email } });

  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const tokens = await createTokenPair(user.id);

  return { user: toAuthUser(user), tokens };
}

/**
 * Exchange a refresh token for a new access + refresh token pair.
 * The old refresh token is revoked (rotation).
 */
export async function refresh(refreshToken: string) {
  const stored = await db.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    // If the token was already used (revoked), someone may have stolen it.
    // Revoke ALL tokens for that user as a safety measure.
    if (stored?.revoked) {
      await db.refreshToken.updateMany({
        where: { userId: stored.userId },
        data: { revoked: true },
      });
    }
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  // Rotate: revoke old, issue new pair
  await db.refreshToken.update({
    where: { id: stored.id },
    data: { revoked: true },
  });

  const tokens = await createTokenPair(stored.userId);

  return { user: toAuthUser(stored.user), tokens };
}

/**
 * Revoke a refresh token (logout).
 */
export async function logout(refreshToken: string) {
  // Silently succeed even if the token doesn't exist
  await db.refreshToken.updateMany({
    where: { token: refreshToken },
    data: { revoked: true },
  });
}

/**
 * Get the current user by ID (from JWT payload).
 */
export async function me(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new NotFoundError("User", userId);
  }

  return toAuthUser(user);
}

/**
 * Verify a JWT access token and return the payload.
 * Throws UnauthorizedError on invalid/expired tokens.
 */
export function verifyAccessToken(token: string): { sub: string } {
  try {
    return jwt.verify(token, env.JWT_SECRET) as { sub: string };
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Create a new access + refresh token pair and persist the refresh token.
 */
async function createTokenPair(userId: string) {
  const accessToken = signAccessToken(userId);
  const refreshTokenValue = generateRefreshToken();

  // Refresh token valid for 7 days (matches JWT_REFRESH_EXPIRES_IN default)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await db.refreshToken.create({
    data: {
      token: refreshTokenValue,
      userId,
      expiresAt,
    },
  });

  return { accessToken, refreshToken: refreshTokenValue };
}
