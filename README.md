# Tulen — Caspian Seal Survey Platform

> Drone footage ingest, seal counts, and population analytics for the Kazakh Caspian sector.

**Tulen** (kaz. «тюлень» — seal) is a Next.js platform for processing UAV survey footage of Caspian seals. It reads the flight track from video sidecars (SRT / JSON) or embedded MP4 GPS, counts seals per sortie, and plots every observation on an interactive Caspian Sea chart with analytics, forecasting, and reporting.

![Next.js 14](https://img.shields.io/badge/Next.js-14.2-black)
![React 18](https://img.shields.io/badge/React-18-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4-06B6D4)
![MapLibre GL](https://img.shields.io/badge/MapLibre_GL-6.2-396CB2)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Usage](#usage)
  - [Ingest Footage](#ingest-footage)
  - [Demo Data](#demo-data)
  - [Map & Layers](#map--layers)
  - [Workbench](#workbench)
  - [Analytics & Forecast](#analytics--forecast)
  - [PDF Export](#pdf-export)
- [Data Formats](#data-formats)
- [Caspian Water Mask](#caspian-water-mask)
- [Scripts](#scripts)
- [Configuration](#configuration)
- [Samples](#samples)
- [Is there a backend?](#is-there-a-backend)
- [Deployment](#deployment)

---

## Features

| Area | What it does |
|---|---|
| **Footage ingest** | Drop `MP4 + SRT`, `MP4 + JSON`, or a standalone video — embedded GPS (`DJI XMP`, `com.apple.quicktime.location`, ISO 6709) is parsed automatically |
| **SRT parser** | Handles DJI classic `GPS(lat,lng,alt)`, `[latitude:] [longitude:]`, and raw `lat,lng,alt` cues with Caspian-basin validation |
| **JSON sidecar parser** | Accepts `{track:[{t,lat,lng}]}`, `{points}`, `{gps}`, arrays, or single-point `{lat,lng}` — tolerant of `lat`/`latitude` and `lng`/`lon`/`longitude` aliases |
| **MP4 metadata scan** | Reads the first 2 MB + last 512 KB of the video as text to find XMP/QuickTime GPS without extra dependencies |
| **Water-aware tracks** | Every track is snapped to the Caspian water mask — land points are nudged toward the sea centre, synthetic tracks are generated when only a single fix exists |
| **Interactive chart** | MapLibre GL dark chart centred on the Caspian (Aktau ≈ 51.18 E / 43.65 N) with footprints, detections, clusters, heatmap, and satellite toggle |
| **Detections** | Deterministic per-video count (2–26 seals, seeded by footage ID) with confidence and bbox — status `auto` / `validated` / `false_positive` |
| **Timeline** | Brush-filter all data by observation date range |
| **Workbench** | Search, sort, and filter detections; bulk validate / flag false positives; inline count editing; CSV export |
| **Analytics Dashboard** | KPIs, monthly trend, region breakdown, group-size histogram, and a 6-month + 3-month forecast |
| **Anomaly detection** | Flags regions where the last 30 days are ≥ 25 % below the prior 90-day mean |
| **Forecast** | Statistical mock (linear trend + seasonality) with confidence bands — swappable to a real model via `POST /api/forecast` |
| **PDF report** | One-click A4 report (jsPDF) with KPIs, forecast bars, anomalies, and a footage table |
| **Manual pinning** | If a video has no GPS, pin the flight path directly on the map |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 14](https://nextjs.org) (App Router, `reactStrictMode`) |
| UI | React 18, Tailwind CSS 3.4, custom design tokens (`--bg`, `--surface`, `--accent` etc.) |
| Map | [MapLibre GL 6.2](https://maplibre.org) + Carto Dark raster + Esri Satellite toggle |
| Charts | [Recharts 3.10](https://recharts.org) |
| State | [Zustand 5](https://zustand-demo.pmnd.rs) (`store/useFootageStore.ts`) |
| PDF | [jsPDF 4.2](https://github.com/parallax/jsPDF) |
| Language | TypeScript 5.4 (`strict: true`) |
| Fonts | Inter + IBM Plex Mono (Google Fonts) |

---

## Project Structure

```
project_hack2/
├── app/
│   ├── layout.tsx        # Root layout — metadata, fonts, <html class="dark">
│   ├── page.tsx          # Main page: map + rail + panels + command palette
│   └── globals.css       # Design tokens, Tailwind layers, MapLibre overrides
├── components/
│   ├── dashboard/
│   │   ├── Dashboard.tsx       # Analytics panel (KPIs, trend, forecast)
│   │   └── ForecastChart.tsx   # Recharts forecast line + band
│   ├── layout/
│   │   ├── TopBar.tsx          # Top navigation / search
│   │   ├── Rail.tsx            # Left icon rail (workbench, layers, analytics)
│   │   ├── LeftPanel.tsx       # Footage / sortie list
│   │   ├── RightInspector.tsx  # Selected sortie detail
│   │   ├── Timeline.tsx        # Date-range brush
│   │   └── CommandPalette.tsx  # ⌘K palette
│   ├── map/
│   │   └── CaspianMap.tsx      # MapLibre instance, sources & layers
│   ├── upload/
│   │   └── Dropzone.tsx        # Drag-and-drop ingest + pin-to-map flow
│   ├── workbench/
│   │   └── Workbench.tsx       # Detections table, bulk actions, CSV export
│   └── ui/
│       ├── primitives.tsx      # Button, IconButton, SectionHead, Stat, Pill …
│       └── Icon.tsx            # Icon set
├── lib/
│   ├── types.ts                # TrackPoint, Detection, Footage, MapLayerState
│   ├── caspian.ts              # CASPIAN_HULL polygon, isWater(), snapToWater()
│   ├── parsers/
│   │   ├── srt.ts              # parseSRT() + validateTrackInCaspian()
│   │   ├── json.ts             # parseJSONSidecar()
│   │   └── mp4.ts              # parseMP4Metadata() — XMP / QuickTime scan
│   ├── mock/
│   │   └── detections.ts       # mockDetections(), generateSeedTrack(), KZ_SITES
│   ├── forecast/
│   │   └── mockForecast.ts     # mockForecast() — trend + seasonality
│   ├── insights/
│   │   └── anomaly.ts          # detectAnomalies()
│   └── export/
│       └── pdf.ts              # exportPDF() via jsPDF
├── store/
│   └── useFootageStore.ts      # Zustand store — footages, detections, layers, timeRange
├── tools/
│   └── inject-srt.js           # CLI: generate a GPS-tagged test MP4 + SRT/JSON sidecars
├── samples/
│   ├── TEST_0100.MP4           # Real 3s clip with GPS in its metadata
│   ├── TEST_0100.srt           # 1 Hz DJI SRT cues
│   └── TEST_0100.json          # JSON sidecar { track: [...] }
├── public/                     # Static assets
├── next.config.js
├── tailwind.config.js          # Content globs + token → Tailwind mapping
├── tsconfig.json               # Path alias @/* → ./*
└── package.json
```

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18.17 (Next.js 14 requirement)
- **npm** (or `yarn` / `pnpm` / `bun` — lockfile is `package-lock.json`)

### Install

```bash
npm install
```

### Develop

```bash
npm run dev
# → http://localhost:3000
```

### Build & serve production

```bash
npm run build
npm start
# → http://localhost:3000
```

### Lint

```bash
npm run lint
```

---

## Usage

### Ingest Footage

1. Click **Ingest** (top-right of the map) or drag files onto the dropzone.
2. Accepted combinations (grouped by basename, e.g. `TEST_0100`):
   - `TEST_0100.MP4` + `TEST_0100.SRT` — DJI SRT cues parsed via `lib/parsers/srt.ts`
   - `TEST_0100.MP4` + `TEST_0100.JSON` — JSON sidecar via `lib/parsers/json.ts`
   - `TEST_0100.MP4` alone — embedded GPS scanned via `lib/parsers/mp4.ts`
3. If no GPS is found, the dropzone prompts you to **pin the flight path** on the map (click to add points, confirm to create the sortie).

Each ingested video becomes a `Footage` record with a `TrackPoint[]` track, a single whole-video `Detection` (count = total seals in that sortie), and a `center` used for map placement.

### Demo Data

With no footage loaded the map shows a centred call-to-action:

- **Upload** — open the ingest panel
- **Load test data** — seeds 16 synthetic sorties around 8 Kazakh Caspian sites (Kendirli, Tyuleniy, Bautino, Kulaly, Aktau, Durneva, Mangystau) plus 8 offshore extras via `store/useFootageStore.ts#seedTestData`. Every seeded sortie is named `TEST_*.MP4` and tagged `source: "test"`, and carries a `test` pill in the footage list and inspector — so synthetic data is never mistaken for a real survey. Uploaded footage carries neither.

Demo tracks are generated with `generateSeedTrack()` (30–40 km synthetic paths, always on water).

### Map & Layers

The chart is centred at **Aktau (51.18 E, 43.65 N), zoom 6.8** and bounded to the Caspian basin.

| Layer | Source | Toggle |
|---|---|---|
| Footprint lines + fill | `footprints` GeoJSON (white, low opacity) | `layerState.footprints` |
| Detections (count badges) | `detections` GeoJSON (amber) | `layerState.detections` |
| Clusters | Aggregated detections | `layerState.clusters` |
| Heatmap | Count-weighted density | `layerState.heatmap` |
| Satellite | Esri World Imagery raster | Local `satellite` toggle |

Use the **timeline brush** (visible when ≥ 2 sorties) to filter both map and analytics by date.

### Workbench

Open via the left rail → **Detections** (modal, `components/workbench/Workbench.tsx`):

- Search by detection ID, footage ID, filename, region, or count
- Filter by `status` (`all` / `auto` / `validated` / `false_positive`) and minimum count
- Sort by date / count / confidence / region
- Select rows for **bulk actions** — validate or flag as false positive
- Inline edit the seal count per detection
- **Export CSV** — `tulen-detections-YYYY-MM-DD.csv`

### Analytics & Forecast

Toggle via the rail → **Analytics** (`components/dashboard/Dashboard.tsx`):

- **KPIs** — total seals, average group, density
- **Trend** — last 6 months of seals per month
- **By region** — bar breakdown (KZ-North / KZ-East / KZ-South)
- **Group-size histogram** — bins `1`, `2–3`, `4–6`, `7+`
- **Forecast** — 6 historical + 3 forecast months (`lib/forecast/mockForecast.ts`) with confidence bands; drivers shown as bullet points (trend + seasonality). Replace with a real model by handling `POST /api/forecast`.
- **Anomalies** — regions ≥ 25 % below the 90-day mean (`lib/insights/anomaly.ts`)

### PDF Export

From the Analytics panel → **PDF** button → `tulen-report-YYYY-MM-DD.pdf` (`lib/export/pdf.ts`):

- Header with date, sortie/seal counts
- KPIs, forecast summary + bar chart, anomalies, and a footage table (first 22 rows)

---

## Data Formats

### SRT (DJI subtitle sidecar)

```
1
00:00:00,000 --> 00:00:00,900
GPS(44.850000,50.350000,75.3) [latitude: 44.850000] [longitude: 50.350000] [rel_alt: 75.3]

2
00:00:01,000 --> 00:00:01,900
GPS(44.850812,50.351102,76.1) ...
```

Supported cue formats (tried in order):
1. `GPS(lat, lng, alt)`
2. `[latitude: …] [longitude: …]`
3. `latitude: …, longitude: …`
4. Raw `lat, lng, alt`

See [`lib/parsers/srt.ts`](lib/parsers/srt.ts) and [`tools/inject-srt.js`](tools/inject-srt.js) for the exact regexes.

### JSON sidecar

Any of these shapes is accepted by `parseJSONSidecar()`:

```json
{ "track": [{ "t": 0, "lat": 44.85, "lng": 50.35, "alt": 75 }] }
{ "points": [{ "t": 0, "lat": 44.85, "lng": 50.35 }] }
{ "gps":    [{ "t": 0, "lat": 44.85, "lng": 50.35 }] }
[{ "t": 0, "lat": 44.85, "lng": 50.35 }]
{ "lat": 44.85, "lng": 50.35 }
```

Aliases: `lat`/`latitude`, `lng`/`lon`/`longitude`, `t`/`time`, `alt`/`altitude`.

### MP4 embedded GPS

`parseMP4Metadata()` reads the head + tail bytes and looks for:

- the binary **3GPP `loci` box** — fixed-point lat/lng, what ffmpeg and many Android cameras write. No text search can find this one, so it is decoded from the raw bytes.
- `GPS(lat,lng)` and `[latitude:] [longitude:]` in DJI XMP
- `<GPSLatitude>` / `<GPSLongitude>` XML tags
- `com.apple.quicktime.location` (ISO 6709: `+43.1234+051.1234/`)
- `exif:GPSLatitude` / `exif:GPSLongitude`

If ≥ 3 fixes are found a track is built; with a single fix a 40-point synthetic track (~30 km) is generated around the snapped water location.

It returns `MP4Location`, not a bare array:

```ts
type MP4Location = {
  track: TrackPoint[] | null;             // ready to ingest
  found: { lat, lng } | null;             // first fix, wherever on earth it is
  outsideSurveyArea: boolean;             // GPS exists, just not in the Caspian
  fixes: number;
};
```

`found` is reported even when the coordinates fall outside the Caspian survey area, so a video that plainly has GPS is never described as having none — the ingest log says *"GPS found at 43.2380, 76.9450 — outside the Caspian survey area"* and offers manual pinning instead.

---

## Caspian Water Mask

`lib/caspian.ts` defines a tight hull (`CASPIAN_HULL`, 20 vertices in `[lng, lat]` GeoJSON order) plus two coastline guards:

- `isEastOfKazakhCoast(lat, lng)` — lat-dependent eastern cutoff (Mangystau / Aktau / Bautino)
- `isWestOfCaspian(lat, lng)` — western cutoff (Dagestan / Azerbaijan)

```ts
isWater(lat, lng)      // hull + both coast guards + bbox check
snapToWater(lat, lng)  // 8-direction radial search + centre bias, fallback to central sea
pointInPolygon(pt, hull) // ray-casting
```

All generated and ingested tracks are snapped through this mask so seals never appear on land.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start Next.js dev server on port 3000 |
| `npm run build` | Production build (`next build`) |
| `npm start` | Serve production build on port 3000 |
| `npm run lint` | ESLint (`next lint`) |
| `npm run inject-srt` | `node tools/inject-srt.js` — generate a GPS-tagged test MP4 + sidecars |

### `tools/inject-srt.js`

Generate DJI-style sidecars for any video (useful when the drone did not write GPS):

```bash
# Single video — writes <video>.srt + <video>.json beside it
node tools/inject-srt.js samples/TEST_0100.MP4 --lat 44.85 --lng 50.35 --duration 120

# Centre shorthand
node tools/inject-srt.js samples/TEST_0100.MP4 --center 44.85,50.35 --duration 90

# Demo mode — create N flights in a folder (defaults to ./samples)
node tools/inject-srt.js --center 43.65,51.18 --out ./samples --count 3 --duration 90
npm run inject-srt -- --center 43.65,51.18 --out ./samples --count 5
```

Each cue is written as:

```
GPS(lat,lng,alt) [latitude: lat] [longitude: lng] [rel_alt: alt] [alt: alt+5]
```

at 1 Hz for `duration` seconds. Centres on land are nudged west into the sea automatically.

---

## Configuration

| File | Purpose |
|---|---|
| [`next.config.js`](next.config.js) | `reactStrictMode: true`, strict ESLint/TS on build |
| [`tailwind.config.js`](tailwind.config.js) | Content globs (`app/`, `components/`, `lib/`), token → Tailwind mapping (`bg`, `surface`, `accent`, …), font families, font-size scale, `shadow.pop` |
| [`tsconfig.json`](tsconfig.json) | `strict`, `jsx: preserve`, path alias `@/* → ./*` |
| [`.eslintrc.json`](.eslintrc.json) | `extends: next/core-web-vitals` |
| [`postcss.config.js`](postcss.config.js) | Tailwind + Autoprefixer |
| [`app/globals.css`](app/globals.css) | CSS variables, base resets, scrollbar, MapLibre popup theming |

Design tokens (`app/globals.css`):

```css
--bg: #0a0a0b;  --surface: #101012;  --surface-2: #17171a;
--line: #232327; --line-soft: #1a1a1d;
--ink: #ececee;  --ink-2: #9c9ca4;   --ink-3: #64646c;
--accent: #e0a13c; --accent-soft: #e0a13c1f; --accent-ink: #17120a;
--good: #6aa88a;  --bad: #c0685f;
```

---

## Samples

**In the app:** open **Ingest** and click **Use the sample clip** — a real 38-second drone video with GPS in its metadata, bundled at `public/samples/FIELD_0001.MP4` and served by the app. One click runs it through the normal ingest path, so nothing needs to be downloaded or generated first.

`samples/` additionally ships generated test flights so both ingest paths can be exercised from disk:

- `TEST_0100.MP4` — a **real, playable** 3-second clip with the GPS fix written into its container metadata (`loci` box). Drop this one on its own to test location-from-video.
- `TEST_0100.srt` — 1 Hz DJI-style GPS cues
- `TEST_0100.json` — `{ track: [...] }` sidecar with the same path

Drop the `.MP4` alone to test embedded-GPS extraction, or the `.MP4` + `.SRT` together (grouped by basename) to test the sidecar path. Regenerate with:

```bash
node tools/inject-srt.js --out ./samples --count 3 --duration 90
```

Encoding the real MP4 needs `ffmpeg` on PATH; without it the generator falls back to a 0-byte placeholder and warns, and only the sidecar path will work.

---

## Is there a backend?

Not yet — and nothing here needs one.

Everything runs in the browser. Video files are read locally with `File.slice()` (only the first 2 MB and last 512 KB, so a 4 GB file costs nothing), the flight track is parsed client-side, state lives in Zustand in memory, and CSV/JSON/PDF exports are generated as blobs. No bytes leave the machine, and there is no database. Refreshing the page clears everything.

A backend becomes necessary for three things, in roughly this order:

| Need | Why the browser can't do it | Shape |
|---|---|---|
| **Real seal detection** | Decoding and running a model over every frame is far too heavy for the client | `POST /api/detect` (multipart video) → `Detection[]` in the existing shape. Swap the `mockDetections()` calls in `store/useFootageStore.ts` and `components/upload/Dropzone.tsx` — nothing else changes. |
| **Persistence** | State is in memory; a refresh wipes it | Postgres/SQLite behind `/api/footage` + object storage for the video files |
| **Multi-user** | No accounts, no sharing | Auth + per-survey ownership |

The detector is the only one that blocks the core flow, and it is deliberately isolated behind one function boundary so it can be dropped in without touching the map, dashboards, or ingest UI.

---

## Deployment

Standard Next.js deployment — any Node host or Vercel:

```bash
npm run build
npm start
```

Environment variables: none required (map tiles are public Carto/Esri URLs, no API keys). Add `.env.local` if you wire a real forecast endpoint (`POST /api/forecast`) or a detection model.

---

*Built for the Kazakh Caspian sector. Replace the mock forecast and mock detections with your production models when ready — the store and export layers are already wired for it.*
