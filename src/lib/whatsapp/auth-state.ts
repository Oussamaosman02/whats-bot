/**
 * Baileys authentication state persisted in Postgres (table `baileys_auth`).
 * Lets the server restart / redeploy anywhere and reconnect without rescanning the QR.
 *
 * Layout: row id "creds" holds AuthenticationCreds; every signal key is stored as
 * "<type>-<id>". Values are encoded with Baileys' BufferJSON so Buffers survive JSON.
 */
import { BufferJSON, initAuthCreds, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../db";
import { getLogger, errInfo } from "../logger";

const log = getLogger("wa:auth");

function encode(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}
function decode<T>(raw: string): T {
  return JSON.parse(raw, BufferJSON.reviver) as T;
}

async function readRow<T>(id: string): Promise<T | null> {
  const rows = await db.select({ data: schema.baileysAuth.data }).from(schema.baileysAuth).where(eq(schema.baileysAuth.id, id)).limit(1);
  return rows[0] ? decode<T>(rows[0].data) : null;
}

async function writeRow(id: string, value: unknown) {
  await db
    .insert(schema.baileysAuth)
    .values({ id, data: encode(value), updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.baileysAuth.id, set: { data: encode(value), updatedAt: new Date() } });
}

export async function usePostgresAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clear: () => Promise<void>;
}> {
  let creds = await readRow<AuthenticationCreds>("creds");
  if (creds) {
    log.info({ me: creds.me?.id, registered: creds.registered }, "loaded existing WhatsApp credentials from Postgres");
  } else {
    creds = initAuthCreds();
    log.info("no WhatsApp credentials in Postgres yet → a QR code will be required (GET /api/whatsapp/qr)");
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      async get(type, ids) {
        const keys = ids.map((id) => `${type}-${id}`);
        const rows = await db.select().from(schema.baileysAuth).where(inArray(schema.baileysAuth.id, keys));
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const row of rows) {
          const id = row.id.slice(type.length + 1);
          out[id] = decode(row.data);
        }
        return out;
      },
      async set(data) {
        const tasks: Promise<unknown>[] = [];
        for (const category of Object.keys(data) as (keyof typeof data)[]) {
          const entries = data[category] ?? {};
          for (const [id, value] of Object.entries(entries)) {
            const key = `${category}-${id}`;
            tasks.push(value ? writeRow(key, value) : db.delete(schema.baileysAuth).where(eq(schema.baileysAuth.id, key)));
          }
        }
        try {
          await Promise.all(tasks);
        } catch (e) {
          log.error({ err: errInfo(e), hint: "Signal keys could not be persisted; messages may fail to decrypt after a restart. Check DATABASE_URL / Neon status." }, "failed to save signal keys");
          throw e;
        }
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      try {
        await writeRow("creds", state.creds);
        log.trace("credentials saved");
      } catch (e) {
        log.error({ err: errInfo(e), hint: "Credentials not persisted → you would need to rescan the QR after a restart." }, "failed to save creds");
      }
    },
    clear: async () => {
      await db.delete(schema.baileysAuth).where(like(schema.baileysAuth.id, "%"));
      log.warn("WhatsApp credentials and keys deleted from Postgres");
    },
  };
}
