import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MaggyBox — YouTube to music box",
  description: "Turn a YouTube video into MIDI and a printable music-box cylinder.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
