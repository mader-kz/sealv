import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "SEALv — Caspian seal survey",
  description: "Drone footage ingest, seal counts, and population analytics for the Kazakh Caspian sector.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /* No <head> font links. Inter and IBM Plex Mono are self-hosted under
     /fonts and declared in globals.css: this app is a static export that has
     to start on a field hotspot which is associated but has no route out,
     where a render-blocking stylesheet from fonts.googleapis.com held first
     paint until that connection timed out.

     lang="kk", not "en": Kazakh is the default UI language, so the exported
     HTML was announcing the wrong language to every screen reader. initLang()
     rewrites it on the client when a different language is remembered. */
  return (
    <html lang="kk" className="dark">
      <body className="bg-bg text-ink antialiased overflow-hidden">{children}<Toaster position="bottom-right" /></body>
    </html>
  );
}
