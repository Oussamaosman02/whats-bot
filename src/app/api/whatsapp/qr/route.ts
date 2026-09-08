import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";
import { AppError } from "@/lib/errors";

/**
 * GET /api/whatsapp/qr?format=html|png|json
 * Starts the connection if needed and returns the current QR. HTML auto-refreshes.
 */
export const GET = route(async ({ query }) => {
  const { format } = query(z.object({ format: z.enum(["html", "png", "json"]).default("html") }));
  const status = whatsapp.getStatus();
  if (status.status === "disconnected" || status.status === "logged_out") await whatsapp.start();
  const qr = whatsapp.getQr();
  if (format === "json") {
    return ok({ status: whatsapp.getStatus(), qr: qr ?? null, dataUrl: await whatsapp.getQrDataUrl() });
  }
  if (format === "png") {
    if (!qr) throw new AppError(409, "no_qr", `No QR available (status: ${whatsapp.getStatus().status}).`, { hint: status.status === "open" ? "Already connected." : "Wait a few seconds and retry; the QR appears once the socket handshakes." });
    const buf = await QRCode.toBuffer(qr, { margin: 1, width: 400 });
    return new NextResponse(new Uint8Array(buf), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }
  const s = whatsapp.getStatus();
  const dataUrl = await whatsapp.getQrDataUrl();
  const body = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${s.status === "open" ? 30 : 5}"><title>WhatsApp link</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b141a;color:#e9edef}main{text-align:center}img{background:#fff;padding:12px;border-radius:12px}code{background:#202c33;padding:2px 6px;border-radius:4px}</style>
<main>
${s.status === "open" ? `<h1>✅ Connected</h1><p>${s.me?.name ?? ""} <code>${s.me?.phone ?? s.me?.jid ?? ""}</code></p>` : dataUrl ? `<h1>Scan with WhatsApp</h1><p>Phone → Settings → Linked devices → Link a device</p><img src="${dataUrl}" width="360" height="360"><p><small>Refreshes every 5 s · status: <code>${s.status}</code></small></p>` : `<h1>Waiting for QR…</h1><p>status: <code>${s.status}</code></p>${s.lastError ? `<p style="color:#f66">${s.lastError}</p><p><small>${s.lastErrorHint ?? ""}</small></p>` : ""}`}
</main>`;
  return new NextResponse(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
});
