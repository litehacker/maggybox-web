import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MaggyBox — YouTube to MIDI",
  description: "Turn a YouTube melody into MIDI and a printable music-box cylinder.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
