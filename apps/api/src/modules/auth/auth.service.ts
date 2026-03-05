/**
 * Auth service — handles password hashing, JWT signing, user creation.
 */

export async function createUser(data: {
  email: string;
  password: string;
  name?: string;
}) {
  // TODO: Hash password, insert into DB, return user
}

export async function verifyCredentials(email: string, password: string) {
  // TODO: Fetch user, compare password hash
}

export async function generateTokens(userId: string) {
  // TODO: Sign access + refresh JWTs
}

export async function refreshAccessToken(refreshToken: string) {
  // TODO: Verify refresh token, return new access token
}
