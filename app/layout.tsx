import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tulen — Caspian seal survey",
  description: "Drone footage ingest, seal counts, and population analytics for the Kazakh Caspian sector.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-bg text-ink antialiased overflow-hidden">{children}</body>
    </html>
  );
}
