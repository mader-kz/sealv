import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

/* One typeface for the whole instrument.

   next/font/google resolves and DOWNLOADS Inter at build time and emits it
   into /_next/static/media — the exported HTML never talks to Google. That
   matters here beyond privacy: this app is a static export that has to start
   on a field hotspot which is associated but has no route out, where a
   render-blocking stylesheet from fonts.googleapis.com held first paint until
   the connection timed out. It also inlines a metric-matched local fallback,
   so the swap into Inter no longer moves the layout under it.

   The Cyrillic subsets are load-bearing, not thorough: Kazakh is the default
   UI language and Russian is used across the sector. ә қ ң ө ү are in
   cyrillic-ext, ғ ұ і in cyrillic. Drop either subset and those glyphs fall
   out of Inter onto whatever the OS offers, mid-word.

   No `weight` — Inter's variable file covers 400/500/600 (and everything
   between) in the same download, so asking for three static instances would
   be three files for one face. */
const inter = Inter({
  subsets: ["latin", "cyrillic", "cyrillic-ext"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "SEALv — Caspian seal survey",
  description: "Drone footage ingest, seal counts, and population analytics for the Kazakh Caspian sector.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /* lang="kk", not "en": Kazakh is the default UI language, so the exported
     HTML was announcing the wrong language to every screen reader. initLang()
     rewrites it on the client when a different language is remembered. */
  return (
    <html lang="kk" className={`${inter.variable} dark`}>
      <body className="bg-bg text-ink antialiased overflow-hidden">{children}<Toaster position="bottom-right" /></body>
    </html>
  );
}
