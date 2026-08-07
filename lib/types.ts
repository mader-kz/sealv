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
