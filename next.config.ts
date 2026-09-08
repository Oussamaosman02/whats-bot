import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / node-only packages that must not be bundled by Turbopack.
  serverExternalPackages: [
    "@whiskeysockets/baileys",
    "pino",
    "postgres",
    "sharp",
    "jimp",
    "link-preview-js",
    "audio-decode",
    "qrcode",
  ],
  output: "standalone",
};

export default nextConfig;
