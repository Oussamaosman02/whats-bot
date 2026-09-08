import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { importExportText, readExportFile } from "@/lib/import";

/**
 * POST /api/groups/:jid/import?force=0|1
 * Body: multipart/form-data with field `file` (zip or txt), OR the raw file bytes with
 * Content-Type application/zip | text/plain. Streams to a temp file; only the .txt inside a zip is read.
 *
 *   curl -X POST "$APP/api/groups/<jid>/import" -H "Authorization: Bearer $API_KEY" -F file=@export.zip
 */
export const POST = route<{ jid: string }>(async ({ req, params, query, reqId, log }) => {
  const { force } = query(z.object({ force: z.string().optional() }));
  const jid = decodeURIComponent(params.jid);
  const dir = await mkdtemp(join(tmpdir(), "wa-import-"));
  try {
    let path: string;
    let name: string;
    const ct = req.headers.get("content-type") ?? "";
    if (ct.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw AppError.badRequest("multipart field `file` is missing.", "Send -F file=@export.zip");
      name = file.name || "export.zip";
      path = join(dir, name.replace(/[^\w.\-]/g, "_"));
      await pipeline(Readable.fromWeb(file.stream() as import("node:stream/web").ReadableStream), createWriteStream(path));
    } else {
      if (!req.body) throw AppError.badRequest("Empty body.", "Upload the export as multipart `file` or as raw bytes with Content-Type application/zip or text/plain.");
      name = ct.includes("zip") ? "export.zip" : "export.txt";
      path = join(dir, name);
      await pipeline(Readable.fromWeb(req.body as import("node:stream/web").ReadableStream), createWriteStream(path));
    }
    const { text, entry } = await readExportFile(path, name);
    log.info({ jid, entry, chars: text.length }, "export file received");
    const report = await importExportText(jid, text, { force: force === "1" || force === "true", reqId });
    return ok({ entry, ...report });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
