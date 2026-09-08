import { NextResponse } from "next/server";
import { route, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { whatsapp } from "@/lib/whatsapp/client";
import { toJid } from "@/lib/whatsapp/jid";

/** GET /api/messages/:id/media?chat=<jid> → media bytes (live download, or the R2 archive after restarts). */
export const GET = route<{ id: string }>(async ({ params, query }) => {
  const { chat } = query(z.object({ chat: z.string() }));
  const media = await whatsapp.getMediaBuffer(toJid(chat), params.id);
  if (!media) throw AppError.notFound("Media not available.", "Not in memory and not archived in R2 (MEDIA_ARCHIVE / size limit / received before the bot joined).");
  return new NextResponse(new Uint8Array(media.buffer), { headers: { "Content-Type": media.mimetype ?? "application/octet-stream", "Content-Disposition": `inline; filename="${media.fileName ?? params.id}"` } });
});
