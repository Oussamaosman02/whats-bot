/**
 * Cloudflare R2 object storage (S3-compatible). Holds sticker files and archived media so the
 * database only keeps keys and metadata.
 *
 *   key layout:  stickers/<sha256hex>.webp
 *                media/<chat>/<waId>.<ext>
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("r2");

let client: S3Client | undefined;

export function r2Enabled() {
  const e = env();
  return Boolean(e.CLOUDFLARE_S3_API_ENDPOINT && e.CLOUDFLARE_S3_ACCESS_KEY && e.CLOUDFLARE_S3_SECRET_KEY && e.CLOUDFLARE_R2_BUCKET_NAME);
}

function cfg() {
  const e = env();
  if (!r2Enabled()) throw AppError.notConfigured("Cloudflare R2 storage", ["CLOUDFLARE_S3_API_ENDPOINT", "CLOUDFLARE_S3_ACCESS_KEY", "CLOUDFLARE_S3_SECRET_KEY", "CLOUDFLARE_R2_BUCKET_NAME"]);
  const u = new URL(e.CLOUDFLARE_S3_API_ENDPOINT!);
  return { endpoint: `${u.protocol}//${u.host}`, bucket: e.CLOUDFLARE_R2_BUCKET_NAME!, publicBase: e.CLOUDFLARE_S3_API_PUBLIC_ENDPOINT?.replace(/\/+$/, "") };
}

function s3() {
  if (client) return client;
  const c = cfg();
  client = new S3Client({ region: "auto", endpoint: c.endpoint, forcePathStyle: true, credentials: { accessKeyId: env().CLOUDFLARE_S3_ACCESS_KEY!, secretAccessKey: env().CLOUDFLARE_S3_SECRET_KEY! } });
  log.debug({ endpoint: c.endpoint, bucket: c.bucket, public: Boolean(c.publicBase) }, "r2 client created");
  return client;
}

export const r2 = {
  enabled: r2Enabled,

  async put(key: string, body: Buffer, contentType: string, metadata?: Record<string, string>) {
    const { bucket } = cfg();
    try {
      await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata }));
      log.debug({ key, bytes: body.length, contentType }, "r2 put");
      return key;
    } catch (e) {
      log.error({ err: errInfo(e), key, hint: "Check CLOUDFLARE_S3_* credentials and that the bucket exists (GET /api/health)." }, "r2 put failed");
      throw new AppError(502, "storage_error", `R2 upload failed for ${key}: ${errInfo(e).message}`, { cause: e });
    }
  },

  async get(key: string): Promise<{ buffer: Buffer; contentType?: string }> {
    const { bucket } = cfg();
    try {
      const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return { buffer: Buffer.from(bytes), contentType: res.ContentType };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") throw AppError.notFound(`Object ${key} not found in R2.`);
      throw new AppError(502, "storage_error", `R2 download failed for ${key}: ${errInfo(e).message}`, { cause: e });
    }
  },

  async exists(key: string) {
    const { bucket } = cfg();
    try {
      await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  },

  async delete(keys: string[]) {
    if (!keys.length) return 0;
    const { bucket } = cfg();
    if (keys.length === 1) {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: keys[0] }));
      return 1;
    }
    let n = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
      n += chunk.length;
    }
    log.info({ deleted: n }, "r2 objects deleted");
    return n;
  },

  /** Public URL when the bucket has a public endpoint, otherwise a presigned URL (1 h). */
  async url(key: string, expiresSec = 3600) {
    const { bucket, publicBase } = cfg();
    if (publicBase) return `${publicBase}/${key}`;
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresSec });
  },

  async ping(): Promise<{ ok: true; bucket: string } | { ok: false; error: string; hint: string }> {
    if (!r2Enabled()) return { ok: false, error: "R2 not configured", hint: "Optional: set CLOUDFLARE_S3_* + CLOUDFLARE_R2_BUCKET_NAME to store media outside the DB." };
    try {
      const key = "whats-bot/_health";
      await r2.put(key, Buffer.from("ok"), "text/plain");
      await r2.delete([key]);
      return { ok: true, bucket: cfg().bucket };
    } catch (e) {
      return { ok: false, error: errInfo(e).message, hint: "R2 credentials/bucket problem – see logs [r2]." };
    }
  },
};

export function extFromMime(mimetype?: string) {
  const mt = (mimetype ?? "").split(";")[0].trim();
  return ({ "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "video/mp4": "mp4", "application/pdf": "pdf" } as Record<string, string>)[mt] ?? "bin";
}
