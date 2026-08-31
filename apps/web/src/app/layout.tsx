export const metadata = {
  title: "MaggyBox — YouTube to MIDI",
  description: "Turn a YouTube video into a music-box MIDI and a printable cylinder.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
