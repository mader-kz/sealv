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
  /* The detector's raw score, or null when the run recorded none - an operator
     placed the point by hand, or the engine predates scoring. It used to be
     coerced to 0, which is not "unknown": 0 is the lowest possible confidence,
     and a sort by score put every unscored animal at the bottom as if the model
     had actively disbelieved it. */
  confidence: number | null;
  bbox?: [number, number, number, number]; // x,y,w,h normalized 0-1 (mock)
  status: "auto" | "validated" | "false_positive";
  /* A verdict this browser applied that the service did not accept. The local
     state is what the reviewer decided, so it stands - but it is not persisted,
     and a UI that shows it identically to a saved one is lying about the
     archive. Absent = nothing to say (never written, or written and accepted). */
  unsaved?: boolean;
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
  /** Immutable time this system received/created the media or observation. */
  ingestedAt?: string | null;
  track: TrackPoint[];
  /* EVERY detection the run produced, including the ones a reviewer rejected.
     Rejections are survey evidence and the only recall data this system will
     ever have, so they are carried, not dropped - which means `detections.length`
     is "rows", not "animals". Anything counting animals filters
     `status !== "false_positive"` (see lib/analytics/count.ts). */
  detections: Detection[];
  center: { lat: number; lng: number };
  /* False for a sortie the service counted but that carries no usable position
     at all - no flight track, no georeferenced animal. Its `center` is NaN and
     must never be rendered as a coordinate; its COUNT is a real measured number
     and stays in the totals. Dropping such a run (which hydrate used to do) is
     how a season's total silently loses a colony. Absent = placed. */
  placed?: boolean;
  /* Region comes only from the service's named site registry. It is never
     inferred from latitude: an absent value is unknown, not a geographic guess. */
  siteRegion?: string | null;
  status: "processing" | "ready" | "error";
  /* Where this sortie's positions came from. `frame` is a quick count: a single
     still cut out of a video and ingested as an image, which trades the
     cross-frame band for speed and must say so wherever the count appears. */
  source: "srt" | "json" | "manual" | "injected" | "test" | "archive" | "frame";
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
  /* The service-side survey this sortie is. Everything below hangs off it, and
     it is what a metadata correction, a note or a retirement is addressed to.
     Absent on test data and on anything this client made up. */
  surveyId?: string;
  /* The colony, once somebody has named one. `siteName` is null for a site
     still known only by its coordinates - which is a real state, not a missing
     one, and the UI shows the coordinates rather than inventing a name. */
  siteId?: string | null;
  siteName?: string | null;
  /* Free-text field notes an operator wrote against this sortie, and who they
     were. Both null until somebody types something; neither is ever inferred. */
  notes?: string | null;
  operator?: string | null;
  /* When the footage was FLOWN or the animals COUNTED, off the survey row.
     Null means the date was never recorded - and then the UI must say so
     rather than print `uploadedAt`, which is when the count job ran. For a
     re-processed archive those two are months apart, and quietly substituting
     one for the other puts a 2019 sortie on this season's timeline. */
  capturedAt?: string | null;
  /* How the position was arrived at: telemetry (a flight track), pinned (an
     operator dropped it on the map), manual (typed in with a ground count).
     A GPS fix and a finger on a map are not the same evidence and the map may
     not draw them identically. Null = never recorded. */
  locationSource?: "telemetry" | "pinned" | "manual" | null;
  /* Withdrawn from the estimate, with the reason and the person who did it.
     Nothing is deleted: a retired sortie keeps every point and every edit, it
     just stops being counted. Null across all three = live. */
  retiredAt?: string | null;
  retiredReason?: string | null;
  retiredBy?: string | null;
  /* Flight metadata the inspector can correct. Altitude drives GSD, which
     drives `areaM2` - correcting it moves the AREA and never the count. */
  altitudeM?: number | null;
  tideState?: string | null;
  /* What produced the number. 'manual' is a person who stood there and
     counted; every other value is an engine. This is the field a UI reads
     before it draws a band, because a human count has no band to draw. */
  engine?: string | null;
  /* How far this run's conditions sat from the ones where false positives were
     actually measured, plus the measurements behind that label. The label alone
     is a bare adjective; `falsePositiveBasis` is what makes it a claim anyone
     can check, so a UI that shows one shows the other. Null = the run never
     recorded it, which is unknown rather than reassuring. */
  falsePositiveRisk?: string | null;
  falsePositiveBasis?: string[] | null;
  /* Set when this sortie is one frame cut out of a video rather than the whole
     clip: which video it came from, and the second it was taken at. Its band is
     a single frame's, so everything that renders the count has to label it -
     the cross-frame agreement that makes a band trustworthy was never run. */
  quickCount?: { fromVideo: string; atSeconds: number } | null;
  /* No `counts` / `verifiedCount`. They mirrored the service's own per-status
     tally onto the Footage and nothing ever read them: the hydrate fetches
     every point of a run, so the inspector, the dashboard and the report
     derive the same figures from `detections` exactly. A second source of
     truth that no screen consults is not a safety net, it is a contract the
     next author will believe is live. */
  error?: string;
};

/* ------------------------------------------------------------- environment

   What the weather, the water and the ice were doing where and when a sortie
   was flown. Shape-for-shape the service's /v1/env/* answers, because the one
   rule this data lives by has to survive the trip into the UI: a value never
   travels without its SOURCE, the MEASUREMENT TIME of the slice it came out
   of, the size of the cell that was measured, and how far both of those are
   from what was asked for. "26.8 °C" is not a thing this product says.

   Note what is NOT here: no "temperature" field, no merged conditions object,
   no defaults. Two SST sources at different resolutions and lags disagree by
   design, and a type with one `sst` field would force somebody to choose
   between them silently. Every source stays its own row. */

/** Every measurable the service can store. `values` is a PARTIAL map over
 *  these: a key that is absent was not measured, which is not zero and must
 *  never be rendered as one. */
export type EnvVar =
  | "wind_ms" | "wind_dir" | "gust_ms" | "air_t" | "pressure" | "cloud"
  | "wave_m" | "wave_period_s"
  | "sst_c" | "sst_anomaly_c"
  | "ice_class" | "ice_conc" | "ice_thickness_m"
  | "chl_a" | "sea_level_m";

/** Stable source ids. The dictionary carries a name and a latency note for
 *  each; an id this build does not know is rendered as the id rather than
 *  dropped, because an unknown feed is exactly what a reader must see. */
export type EnvSourceId =
  | "mur" | "coraltemp" | "ims" | "viirs_ice" | "viirs_chl"
  | "gwm_sea_level" | "openmeteo_icon_eu" | "openmeteo_era5" | "openmeteo_mfwam";

/** "point" describes the cell at a coordinate; "basin" describes the WHOLE
 *  SEA (sea level is one altimetric figure per ten days). The distance of a
 *  basin row from the asked-for point is real and large - it is stored at the
 *  altimetry crossing - and rendering that as "320 km away" would be true and
 *  useless. `scope` is what says to render it as "whole sea" instead. */
export type EnvScope = "point" | "basin";

export type EnvValues = Partial<Record<EnvVar, number>>;

/** One source's answer for one point and one moment. */
export type EnvSample = {
  source: string;
  /** The exact product identifier (jplMURSST41, icon_eu…). */
  dataset: string;
  /** The SLICE this came out of - not the time that was asked about. */
  measured_at: string;
  /** The centre of the cell that was returned, not the point that was asked
   *  for; `distance_km` is the gap between them. */
  lat: number;
  lng: number;
  values: EnvValues;
  /** How wide ONE MEASURED CELL is, in metres. Null for a basin figure. */
  resolution_m: number | null;
  /** The same fact as prose, from the service ("0.01° (~1 km)"). */
  resolution: string;
  scope: EnvScope;
  latency_note: string;
  fetched_at?: string;
  /** |measured_at − asked-for time|, in hours. */
  gap_hours: number;
  /** Cell centre to the asked-for point, in km. */
  distance_km: number;
};

/** A source in the catalogue that has nothing to say here, and why. Rendered
 *  as an explicit gap - never omitted, never drawn as a zero. */
export type EnvMissing = {
  source: string;
  vars: string[];
  reason: string;
};

/** The full catalogue, served with every answer so a feed that has been broken
 *  since the first collection cycle is visible rather than simply absent. */
export type EnvSourceMeta = {
  source: string;
  dataset: string;
  vars: string[];
  resolution_m: number | null;
  resolution: string;
  scope: EnvScope;
  latency_note: string;
};

/** GET /v1/env/at - conditions at one point and moment, every source kept
 *  separate. At most one sample per source. */
export type EnvAt = {
  point: { lat: number; lng: number };
  time: string;
  radius_km: number;
  max_gap_h: number;
  max_gap_basin_h: number;
  live: boolean;
  samples: EnvSample[];
  missing: EnvMissing[];
  sources: EnvSourceMeta[];
};

/* Only the layers the map still draws. `clusters` and `heatmap` outlived the
   heat layer that was removed for painting a density nobody measured; a dead
   field in a shared type reads as a contract to the next author. */
export type MapLayerState = {
  footprints: boolean;
  detections: boolean;
};

/* No `SiteMeta`. It described a site registry this client never had - the
   service owns `site`, and nothing in the app ever read the type. A shared type
   with no reader is a promise the codebase does not keep. */
