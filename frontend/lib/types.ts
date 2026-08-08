export type TrackPoint = {
  t: number; // seconds from video start
  lat: number;
  lng: number;
  alt?: number;
  timestamp?: string; // original SRT timestamp
};

export type Detection = {
  id: string;
  footageId: string;
  t: number;
  lat: number;
  lng: number;
  count: number;
  confidence: number;
  bbox?: [number, number, number, number]; // x,y,w,h normalized 0-1 (mock)
  status: "auto" | "validated" | "false_positive";
  /* Pixel position of this animal in the source/reference frame's coordinate
     system. The Evidence view draws verdicts on the actual photo, where
     geography is irrelevant but pixels are everything. Absent on mock/test
     detections - the engine is the only honest source of them. */
  px?: number;
  py?: number;
};

/* One engine detection in the pixel space of the source/reference frame.
   Kept for ALL non-false-positive points - including the ones the map cannot
   place (no lat/lng) - because an animal without coordinates is still visible
   in the photo, and the Evidence view must show it. */
export type DetectionPixel = {
  px: number;
  py: number;
  status: string;
  score: number | null;
  id: number;
};

export type Footage = {
  id: string;
  filename: string;
  size: number;
  duration: number; // seconds
  uploadedAt: string;
  track: TrackPoint[];
  detections: Detection[];
  center: { lat: number; lng: number };
  /* No `region`. It was `center.lat > 44.5 ? "KZ-East" : …` — a latitude
     threshold wearing a toponym's clothes, invented at ingest and then shown,
     charted, exported and put in sentences as if it were a place. The measured
     thing is the centre coordinate, and that is what the UI shows. A real
     region needs the service's `site` table, not an if-else. */
  status: "processing" | "ready" | "error";
  source: "srt" | "json" | "manual" | "injected" | "test" | "archive";
  videoUrl?: string; // object URL
  /* The honest answer of a real count: a low/best/high range with the method
     that produced it. Absent on test data - the mock never had one, and
     inventing a range for synthetic sorties would defeat its point. */
  band?: { low: number | null; best: number | null; high: number | null; basis: string };
  /* The run behind this footage, when the real engine produced it. Absent on
     test data. It is what lets an operator edit persist to the service. */
  runId?: string;
  /* Animals the engine found but could not georeference (no flight track).
     They are in the count; they are not on the map. The UI must say so. */
  unplaced?: number;
  /* Every non-false-positive detection in reference-frame pixel space,
     placed or not. The raw material of the Evidence view. */
  pixels?: DetectionPixel[];
  /* Backend media id for this sortie's source file - what /media/{id}/file
     is fed to show the actual footage behind the count. */
  mediaId?: string;
  /* Ground one media footprint covers, in square metres: width * height *
     (gsd/100)^2. Null when the scale is unknown - there is no honest area
     without a GSD, and a made-up one would put a fabricated denominator under
     every density figure downstream. */
  areaM2?: number | null;
  /* The engine's own reasons not to trust its band, verbatim from the run's
     quality ledger (failed tiles, dropped frames, a union passed off as
     consensus). An empty array is a clean run; ABSENT means the engine never
     reported - which is not the same claim, and must not be rendered as one. */
  caveats?: string[];
  /* Scale, and how it was arrived at (explicit | optics | assumed_* |
     unknown). The source matters as much as the number: an assumed GSD is a
     guess that silently shifts every derived area. */
  gsdCmPx?: number | null;
  gsdSource?: string | null;
  error?: string;
};

/* Only the layers the map still draws. `clusters` and `heatmap` outlived the
   heat layer that was removed for painting a density nobody measured; a dead
   field in a shared type reads as a contract to the next author. */
export type MapLayerState = {
  footprints: boolean;
  detections: boolean;
};

export type SiteMeta = {
  id: string;
  name: string;
  region: "KZ-North" | "KZ-East" | "KZ-South" | "AZ" | "RU" | "TM" | "IR";
  lat: number;
  lng: number;
};
