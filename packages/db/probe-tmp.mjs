import { PGlite } from "@electric-sql/pglite";
const db = new PGlite("/tmp/osprobe");
const q = async (sql) => { try { return (await db.query(sql)).rows; } catch (e) { return [{ err: String(e.message ?? e).slice(0,120) }]; } };
console.log("tables:", (await q("select count(*) n from information_schema.tables where table_schema='public'"))[0]);
for (const t of ["organization","project","servers","service","deployment","docker_migration_run","\"user\""]) {
  const r = await q(`select count(*) n from ${t}`);
  console.log(String(t).padEnd(22), JSON.stringify(r[0]));
}
console.log("--- projects:");
console.log(await q("select id, name, slug, server_id, deleted_at from project order by created_at desc limit 10"));
await db.close();
