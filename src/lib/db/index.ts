import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../env";
import { getLogger, errInfo } from "../logger";

const log = getLogger("db");

const g = globalThis as unknown as { __whatsbotSql?: ReturnType<typeof postgres> };

function createClient() {
  const url = env().DATABASE_URL;
  const host = url.replace(/^.*@/, "").replace(/\/.*$/, "");
  log.debug({ host }, "creating postgres client");
  const sql = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false, // required for Neon's pooled (pgbouncer) endpoints
    onnotice: () => {},
  });
  return sql;
}

export const sql = g.__whatsbotSql ?? (g.__whatsbotSql = createClient());
export const db = drizzle(sql, { schema });
export { schema };

/** Cheap connectivity probe used by /api/health. */
export async function pingDb(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string; hint: string }> {
  const t0 = Date.now();
  try {
    await sql`select 1`;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    const info = errInfo(e);
    log.error({ err: info, hint: "Check DATABASE_URL and that the Neon project is not suspended." }, "db ping failed");
    return {
      ok: false,
      error: info.message,
      hint: "Check DATABASE_URL (see .env.example). Run `npm run db:push` once to create the tables.",
    };
  }
}
