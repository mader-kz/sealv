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
  region: string;
  status: "processing" | "ready" | "error";
  source: "srt" | "json" | "manual" | "injected" | "test";
  videoUrl?: string; // object URL
  /* The honest answer of a real count: a low/best/high range with the method
     that produced it. Absent on test data - the mock never had one, and
     inventing a range for synthetic sorties would defeat its point. */
  band?: { low: number | null; best: number | null; high: number | null; basis: string };
  /* Animals the engine found but could not georeference (no flight track).
     They are in the count; they are not on the map. The UI must say so. */
  unplaced?: number;
  error?: string;
};

export type MapLayerState = {
  footprints: boolean;
  detections: boolean;
  clusters: boolean;
  heatmap: boolean;
};

export type SiteMeta = {
  id: string;
  name: string;
  region: "KZ-North" | "KZ-East" | "KZ-South" | "AZ" | "RU" | "TM" | "IR";
  lat: number;
  lng: number;
};
