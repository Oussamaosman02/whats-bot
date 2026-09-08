import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "whats-bot API",
  description: "WhatsApp group summary bot – API only",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", background: "#0b141a", color: "#e9edef", margin: 0 }}>{children}</body>
    </html>
  );
}
