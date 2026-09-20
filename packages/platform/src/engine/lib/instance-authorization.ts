import { db, schema, eq } from "@repo/db";
import { createInstanceAuthorization } from "@repo/platform";

export const instanceAuthorization = createInstanceAuthorization({
  async findUserRole(userId) {
    const [row] = await db
      .select({ role: schema.user.role })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    return row?.role;
  },
});
