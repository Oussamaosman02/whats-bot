import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "10vh auto", padding: 24, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 22 }}>whats-bot · API only</h1>
      <p>WhatsApp group-summary bot. There is no UI; everything is under <code>/api</code>.</p>
      <ul>
        <li><Link href="/api">GET /api</Link> – endpoint index</li>
        <li><Link href="/api/health">GET /api/health</Link> – deep health check</li>
        <li><Link href="/api/whatsapp/qr">GET /api/whatsapp/qr</Link> – link the WhatsApp number (QR)</li>
      </ul>
    </main>
  );
}
