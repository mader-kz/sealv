"use client";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { useIngestStore } from "@/store/useIngestStore";
import { useEnvStore } from "@/store/useEnvStore";
import EnvLayer from "./EnvLayer";
import { colonyHull, expandHull, colonyBounds } from "@/lib/colony";
import { footagesInRange, detectionsFor } from "@/lib/analytics/brush";
import { applyLinkReviews, trackSealGroups } from "@/lib/analytics/tracking";
import type { GroupObservation, GroupTrack, TrackPrediction } from "@/lib/analytics/tracking";
import { detectRegionAvoidance } from "@/lib/analytics/avoidance";
import { CASPIAN_REGION_BOUNDARIES } from "@/lib/analytics/caspianRegions";
import { CASPIAN_DISPLAY_OUTLINE } from "@/lib/caspianOutline";
import { EvidenceFrame } from "@/components/evidence/EvidenceView";
import type { Detection, Footage } from "@/lib/types";
import { localeFor, useT } from "@/lib/i18n";
import { parseLatLng } from "@/lib/parsers/latlng";
import { Button } from "@/components/ui/primitives";
import { setMode } from "@/lib/modes";
import {
  fetchPollution,
  fetchPollutionChanges,
  fetchPollutionStatus,
  mergePollution,
  pollutionAgeBucket,
  pollutionDisplay,
  pollutionUncertainty,
} from "@/lib/pollution";
import type { PollutionFC, PollutionFeature } from "@/lib/pollution";

// Caspian bounds
const CASPIAN_BOUNDS: [[number, number],[number,number]] = [[46,36],[55,48]];
const AKTAU: [number, number] = [51.18, 43.65];

function circleRing(center:{lat:number;lng:number},radiusKm:number,steps=64):number[][]{
  const latRadians=center.lat*Math.PI/180;
  const latScale=radiusKm/111.32;
  const lngScale=radiusKm/(111.32*Math.max(0.15,Math.cos(latRadians)));
  const ring=Array.from({length:steps},(_,index)=>{
    const angle=(index/steps)*Math.PI*2;
    return [center.lng+Math.cos(angle)*lngScale,center.lat+Math.sin(angle)*latScale];
  });
  ring.push(ring[0]);
  return ring;
}

/* The three reading distances of the chart. Far: one chip per sortie — a
   count with its honesty band, nothing else. Mid: the chip grows a colony
   outline under it. Close: the outline fills with the individual animals.
   The chip never leaves — it is the sortie's handle at every zoom. */
const ZOOM_COLONY = 8.2;   // hull outlines appear
const ZOOM_ANIMALS = 11.5; // per-animal dots appear

const EMPTY_FC = { type: "FeatureCollection", features: [] as any[] };

type MapPoint = [number,number];

/* Clip the existing water hull against one of the two reporting thresholds.
   This keeps the basin tint on the sea instead of washing three rectangular
   bands across the surrounding land. The classifier clamps each conventional
   landmark line at its endpoints; binary search mirrors that exact shape at
   the two short horizontal continuations without duplicating its arithmetic. */
function boundaryLatitudeAt(boundary:readonly [{lat:number;lng:number},{lat:number;lng:number}],lng:number):number{
  const [west,east]=boundary[0].lng<=boundary[1].lng ? boundary : [boundary[1],boundary[0]];
  const x=Math.max(west.lng,Math.min(east.lng,lng));
  const part=(x-west.lng)/(east.lng-west.lng || 1);
  return west.lat+(east.lat-west.lat)*part;
}

function clipToBoundary(polygon:readonly MapPoint[],boundary:readonly [{lat:number;lng:number},{lat:number;lng:number}],keepNorth:boolean):MapPoint[]{
  const input=polygon.length>1 && polygon[0][0]===polygon[polygon.length-1][0] && polygon[0][1]===polygon[polygon.length-1][1]
    ? polygon.slice(0,-1)
    : [...polygon];
  if(!input.length) return [];
  const side=(point:MapPoint)=>point[1]-boundaryLatitudeAt(boundary,point[0]);
  const inside=(point:MapPoint)=>keepNorth ? side(point)>=0 : side(point)<=0;
  const output:MapPoint[]=[];
  let previous=input[input.length-1];
  let previousInside=inside(previous);
  for(const current of input){
    const currentInside=inside(current);
    if(currentInside!==previousInside){
      let lo=0,hi=1;
      for(let i=0;i<32;i++){
        const t=(lo+hi)/2;
        const probe:[number,number]=[
          previous[0]+(current[0]-previous[0])*t,
          previous[1]+(current[1]-previous[1])*t,
        ];
        if(inside(probe)===previousInside) lo=t; else hi=t;
      }
      const t=(lo+hi)/2;
      output.push([
        previous[0]+(current[0]-previous[0])*t,
        previous[1]+(current[1]-previous[1])*t,
      ]);
    }
    if(currentInside) output.push(current);
    previous=current;
    previousInside=currentInside;
  }
  if(output.length) output.push([...output[0]] as MapPoint);
  return output;
}

const BELOW_NORTH=clipToBoundary(CASPIAN_DISPLAY_OUTLINE,CASPIAN_REGION_BOUNDARIES.northCentral,false);
const CASPIAN_REGION_RINGS={
  north:clipToBoundary(CASPIAN_DISPLAY_OUTLINE,CASPIAN_REGION_BOUNDARIES.northCentral,true),
  central:clipToBoundary(BELOW_NORTH,CASPIAN_REGION_BOUNDARIES.centralSouth,true),
  south:clipToBoundary(CASPIAN_DISPLAY_OUTLINE,CASPIAN_REGION_BOUNDARIES.centralSouth,false),
} as const;

function hullLongitudesAtLatitude(polygon:readonly MapPoint[],lat:number):number[]{
  const hits:number[]=[];
  for(let index=0;index<polygon.length;index++){
    const a=polygon[index];
    const b=polygon[(index+1)%polygon.length];
    if((a[1]<=lat && b[1]>lat)||(b[1]<=lat && a[1]>lat)){
      const t=(lat-a[1])/(b[1]-a[1]);
      hits.push(a[0]+(b[0]-a[0])*t);
    }
  }
  return hits;
}

/* The analytical threshold is clamped beyond its two named landmarks. Draw
   those same short horizontal continuations up to the water-mask edges. The
   former line source stopped at the landmarks while the fills continued to
   the shore, so their boundaries visibly disagreed even though both were
   based on the same classifier. */
function fullWaterBoundary(boundary:readonly [{lat:number;lng:number},{lat:number;lng:number}]):MapPoint[]{
  const [west,east]=boundary[0].lng<=boundary[1].lng ? boundary : [boundary[1],boundary[0]];
  const westHits=hullLongitudesAtLatitude(CASPIAN_DISPLAY_OUTLINE,west.lat);
  const eastHits=hullLongitudesAtLatitude(CASPIAN_DISPLAY_OUTLINE,east.lat);
  const shoreWest=westHits.length ? Math.min(...westHits) : west.lng;
  const shoreEast=eastHits.length ? Math.max(...eastHits) : east.lng;
  return [
    [shoreWest,west.lat],
    [west.lng,west.lat],
    [east.lng,east.lat],
    [shoreEast,east.lat],
  ];
}

const CASPIAN_REGION_BOUNDARY_LINES={
  northCentral:fullWaterBoundary(CASPIAN_REGION_BOUNDARIES.northCentral),
  centralSouth:fullWaterBoundary(CASPIAN_REGION_BOUNDARIES.centralSouth),
} as const;

const CASPIAN_REGION_LABEL_POINTS={
  north:{lng:48.15,lat:45.55},
  central:{lng:50.85,lat:42.15},
  south:{lng:50.35,lat:39.95},
} as const;
const CASPIAN_REGIONS=["north","central","south"] as const;

/* Prediction is deliberately optional. The tracker can be deployed before a
   forecast exists, and older archive payloads must keep rendering. Validate
   the coordinate at this boundary so malformed analytics never poison the
   entire GeoJSON source with NaN. */
function predictionOf(track: GroupTrack): TrackPrediction | null {
  const raw = track.prediction;
  if (!raw) return null;
  const lat = Number(raw.center?.lat);
  const lng = Number(raw.center?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return raw;
}

/** A hand-placed coordinate, at the precision a click supports (~110 m). */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const DARK_STYLE: any = {
  version: 8,
  // Use Carto Dark + Esri Satellite as raster overlay trick? For MVP use simple dark with coastline emphasis
  sources: {
    osm: {
      type: "raster",
      /* MapLibre does not expand Leaflet's `{r}` retina placeholder. Leaving
         it in the template percent-encodes the braces and turns every tile
         request into a 404. A fixed 256 px URL is correct for this source. */
      tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png","https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© Carto © OpenStreetMap",
    },
    esri: {
      type: "raster",
      // blankTile=false: where imagery runs out, the server answers 404
      // instead of a grey "map data not yet available" plate — and a raster
      // tile that errors leaves the overzoomed parent imagery on screen,
      // which is the honest rendering of "this is as sharp as it gets".
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false"],
      tileSize: 256,
      attribution: "Esri",
    }
  },
  layers: [
    // GL cannot read CSS vars — #0b0d10 is --bg baked in, so map void = app bg.
    { id: "bg", type: "background", paint: { "background-color": "#0b0d10" } },
    // Dial the basemap right down — it is context, and the counts drawn on top
    // are the only things that should carry contrast. brightness-min lifts the
    // tile blacks off the floor so water/land separate from the app background
    // instead of pooling into one tar pit with it.
    // Fully desaturated on purpose: the chart is near-monochrome and the one
    // signal colour belongs to the counts, so a basemap that keeps its own
    // olive-and-slate is a second palette arguing with the first. Saturation
    // -1 with the contrast lifted trades that colour back for legible
    // coastline — land and water separate by value now, not by hue.
    { id: "osm", type: "raster", source: "osm", paint: {
      "raster-opacity": 1,
      "raster-brightness-min": 0.12,
      "raster-brightness-max": 0.84,
      "raster-saturation": -1,
      "raster-contrast": 0.18,
    } },
  ],
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
};

/**
 * One chip per SITE — the map's unit of reading, and the one thing about this
 * component that the mode rewrite changed.
 *
 * It used to be one chip per SORTIE, which meant three visits to one beach drew
 * three chips stacked on the same 200 m of coast, each with a different number,
 * and the reader had to know that only the newest of them was in the season
 * estimate. A site says the thing the estimate is actually made of: one place,
 * its standing count, and — when it has been flown more than once — the shape
 * of the visits behind that count.
 *
 * This is a DATA-INPUT change and deliberately nothing more. The anchor →
 * project → diff → absolutely-positioned-DOM pipeline below is untouched: the
 * chips are still plain DOM (they render under any GL backend, headless
 * included), still projected in the same rAF pass, still diffed by sameChips
 * before they touch React. What changed is who fills the array — SeasonMode
 * clusters the season with the shared groupIntoSites/siteSeries helpers and
 * hands the result down, so the chip on the map and the card that opens from it
 * can never disagree about what a site is.
 */
export type SiteChip = {
  /** Stable identity of the site: its assigned id, else its centroid. */
  key: string;
  lat: number;
  lng: number;
  /** The name somebody typed, or null — never a placeholder. An unnamed site
   *  is shown by its coordinates, which are the thing that is true about it. */
  name: string | null;
  /** The site's STANDING count — its latest visit that produced one. Null when
   *  every visit is retired or produced nothing: an unknown, never a zero. */
  count: number | null;
  low: number | null;
  high: number | null;
  /** One value per counted visit, oldest first. Two or more draw the spark. */
  spark: number[];
  visits: number;
  /** No standing count. The chip stays (the place was surveyed) and goes quiet. */
  retired: boolean;
  /** The sorties at this site — what the camera frames when the chip is
   *  clicked. Ids only; the map reads their points from the store. */
  footageIds: string[];
};

/* A chip, once projected. `x`/`y` are canvas pixels; everything else is the
   SiteChip it came from, copied flat so sameChips can diff without walking. */
type ColonyChip = SiteChip & { x: number; y: number; ay: number };

/* Push overlapping markers apart vertically. Two sites a couple of kilometres
   apart project onto the same pixels at basin zoom, and the upper marker then
   swallows the lower one's clicks. The estimate matches the compact icon/count
   marker; a few extra pixels of separation cost less than an unreachable site.
   `ay` keeps the true anchor so a displaced marker can draw a stalk back to the
   coordinate it actually claims. */
/* How far past the canvas edge a chip may still be worth rendering. Inside
   this margin a chip is partly on screen (the layer clips the rest, which is
   the correct reading — the count is sliding off the edge); beyond it there
   is nothing to see, so the node is dropped rather than kept alive off-frame.
   A little wider than the tallest chip so one never pops out of existence
   while a sliver of it is still legible. */
const CHIP_CULL_MARGIN = 160;
const offCanvas = (x: number, y: number, rect: { width: number; height: number }) =>
  x < -CHIP_CULL_MARGIN || x > rect.width + CHIP_CULL_MARGIN ||
  y < -CHIP_CULL_MARGIN || y > rect.height + CHIP_CULL_MARGIN;

function separateChips(chips: ColonyChip[]) {
  const H = 44;
  const W = 88;
  const byY = [...chips].sort((a, b) => a.y - b.y);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < byY.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = byY[j], b = byY[i];
        if (Math.abs(a.x - b.x) >= W) continue;
        const need = H + 4;
        const gap = b.y - a.y;
        if (gap < need) b.y = a.y + need;
      }
    }
  }
}

/* The exact supplied artwork, with only its connected navy background removed. */
function SealMarkerIcon() {
  return <span className="seal-marker-icon" aria-hidden="true" />;
}

/* A tracked group's dated observations are not sortie totals. They get their
   own cards while a route is focused so a 415-animal whole-flight chip cannot
   masquerade as one 20-animal group's history. Straight screen-space links
   connect the cards; they are inferred adjacency, never a travelled GPS
   trail. */
type MovementObservationCard = {
  x: number;
  y: number;
  lat: number;
  lng: number;
  trackId: string;
  id: string;
  index: number;
  size: number;
  observedAt: string;
  latest: boolean;
  selected: boolean;
  expanded: boolean;
  dimmed: boolean;
  anomalous: boolean;
  checkpoint: boolean;
};

type AvoidanceRegionOverlay = {
  id:string;
  region:string;
  lat:number;
  lng:number;
  radiusKm:number;
  latestCount:number;
};

type ProjectedAvoidanceRegion = AvoidanceRegionOverlay & { x:number;y:number };

/* A colony outline, ready for GeoJSON: [lng,lat] pairs with the ring closed.
   Cached per sortie — see hullCacheRef. */
type ColonyRing = { fid: string; ring: number[][] };

/* Cheap identity of one sortie's placed point set: length, then a fold over
   every id AND every coordinate rounded to ~1 m. Membership changes (a
   verdict flipping a point in or out of `placed`) and any re-placement of the
   points both move the fold, so a cached hull can never outlive its input.

   Hulls are by far the most expensive thing this component computes —
   colony.ts carve() is O(carves x interior) with a nested triangle guard and
   an O(hull) crossing test per candidate — so they are computed once per
   point set and reused across every selection click, pin move and pan. */
function pointsSignature(pts: Detection[]): string {
  let h = 0;
  for (const d of pts) {
    const s = d.id;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    h = (Math.imul(h, 31) + ((d.lat * 1e5) | 0)) | 0;
    h = (Math.imul(h, 31) + ((d.lng * 1e5) | 0)) | 0;
  }
  return pts.length + ":" + h;
}

/* The presence disc — what a site draws when its animals could not be placed.
   A sortie with no ground-sample-distance yields a count and no coordinates,
   so at close zoom its chip used to float over empty water while every
   georeferenced neighbour showed dots and a hull. The disc is the honest mark
   for that state: it says "this many animals, somewhere in here" and nothing
   more. It is dashed for exactly that reason — the extent was never measured —
   and it is drawn ONLY where there are no placed detections, so a measured
   position is never faked or approximated away. */
const PRESENCE_VERTICES = 48;
/* The same equirectangular metre used by lib/colony.ts, restated rather than
   imported: one circle needs the constant, not the projection machinery. */
const METERS_PER_DEG = 111320;
/* Magnitude at a glance, not a confidence radius: 25 seals ≈ 425 m,
   575 ≈ 900 m, and the clamp keeps it between "visible" and "not a claim
   about the whole bay". */
const presenceRadius = (count: number) =>
  Math.min(1500, Math.max(350, 300 + 25 * Math.sqrt(count)));

function presenceRing(lat: number, lng: number, radiusM: number): number[][] {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const ring: number[][] = [];
  for (let i = 0; i < PRESENCE_VERTICES; i++) {
    const th = (i / PRESENCE_VERTICES) * Math.PI * 2;
    ring.push([
      lng + (Math.cos(th) * radiusM) / (cosLat * METERS_PER_DEG),
      lat + (Math.sin(th) * radiusM) / METERS_PER_DEG,
    ]);
  }
  ring.push(ring[0]); // GeoJSON rings close explicitly
  return ring;
}

export default function CaspianMap({
  onMapReady,
  siteChips,
  selectedSiteKey,
  onSiteClick,
  onMovementFocus,
  onPollutionFocus,
  historyFootageIds,
  standingFootageIds,
  checkpointFootageId,
  pollutionReferenceTime,
}: {
  onMapReady?: (m: any)=>void;
  /** One chip per site, from the mode that owns the season's grouping. */
  siteChips?: SiteChip[];
  selectedSiteKey?: string | null;
  onSiteClick?: (key: string)=>void;
  /** Movement cards open the group inspector, so any site inspector already
      occupying the same side of the map has to yield first. */
  onMovementFocus?: ()=>void;
  /** Pollution evidence uses the same exclusive map inspector slot. */
  onPollutionFocus?: ()=>void;
  /** Knowledge available at the selected immutable checkpoint. */
  historyFootageIds?: readonly string[] | null;
  /** Latest-per-site sorties whose groups make up the displayed total. */
  standingFootageIds?: readonly string[] | null;
  /** Upload timestamp whose changed standing card(s) should be highlighted. */
  checkpointFootageId?: string | null;
  /** Environmental evidence is filtered and aged at the selected checkpoint. */
  pollutionReferenceTime?: string | null;
}) {
  const { lang, t, tp } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [satellite, setSatellite] = useState(false);
  /* The live zoom, kept for the pin readout. Updated in the same rAF pass the
     chip overlay already runs, so it costs nothing extra. */
  const [zoomNow, setZoomNow] = useState<number | null>(null);
  const [pollution, setPollution] = useState<PollutionFC>({ type: "FeatureCollection", features: [] });
  const [pollutionError, setPollutionError] = useState(false);
  const [pollutionHealth, setPollutionHealth] = useState<{ failed: number; stale: number } | null>(null);
  const [showPollution, setShowPollution] = useState(true);
  const [selectedPollutionId, setSelectedPollutionId] = useState<string | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const footagesRaw = useFootageStore(s=>s.footages);
  const detectionsRaw = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);
  const hydrating = useFootageStore(s=>s.hydrating);
  /* SeasonMode supplies an exact checkpoint prefix. The archive brush is a
     separate range tool and must not silently filter this screen after a user
     returns from Архив. The fallback keeps this component usable on any older
     call site that has not adopted checkpoints. */
  const footages = useMemo(()=>{
    if(historyFootageIds){
      const ids=new Set(historyFootageIds);
      return footagesRaw.filter(footage=>ids.has(footage.id));
    }
    return footagesInRange(footagesRaw,timeRange);
  },[footagesRaw,timeRange,historyFootageIds]);
  const standingIdSet=useMemo(()=>new Set(standingFootageIds ?? []),[standingFootageIds]);
  const detections = useMemo(()=> detectionsFor(footages, detectionsRaw), [footages, detectionsRaw]);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const selectedMovementId = useFootageStore(s=>s.selectedPopulationId);
  const selectedObservationId = useFootageStore(s=>s.selectedObservationId);
  const selectPopulation = useFootageStore(s=>s.selectPopulation);
  const selectPopulationObservation = useFootageStore(s=>s.selectPopulationObservation);
  const layerState = useFootageStore(s=>s.layerState);
  const setLayer = useFootageStore(s=>s.setLayer);
  const trackingOptions = useFootageStore(s=>s.trackingOptions);
  const populationReviews = useFootageStore(s=>s.populationReviews);
  const populations = useFootageStore(s=>s.populations);
  const syncTrackedPopulations = useFootageStore(s=>s.syncTrackedPopulations);
  const pinMode = useFootageStore(s=>s.pinMode);
  const pinPoints = useFootageStore(s=>s.pinPoints);
  /* How the current pin arrived — a click or a typed coordinate. The
     readout states a different precision for each, because the store
     rounds one of them and keeps the other verbatim. */
  const pinEntry = useIngestStore(s=>s.pinEntry);
  /* Which file is waiting for this point, if any. The card's Confirm exists
     only when there is one to apply it to. */
  const pinTarget = useIngestStore(s=>s.pinTarget);
  const setPinPoints = useFootageStore(s=>s.setPinPoints);
  /* Depend on the individual booleans, not on the layerState object: setLayer hands
     back a fresh object every toggle, so an effect keyed on the object re-ran
     for a flag it does not read. */
  const showTracks = layerState.footprints;
  const showColonies = layerState.detections;
  /* The environment layer keeps its own store: it carries a moment, a chosen
     field and a fetch of its own, and none of that belongs in the sortie
     store, where it would put a network request behind every counts render.
     This file only owns the toggle and where the layer is mounted. */
  const envOn = useEnvStore(s=>s.enabled);
  const setEnvOn = useEnvStore(s=>s.setEnabled);

  /* Movement is inferred from the same brushed sorties the map shows. The
     matcher groups each sortie independently before it links anything across
     time, so points from two survey dates can never become one giant spatial
     cluster merely because both dates are visible. */
  const movementResult = useMemo(
    ()=> applyLinkReviews(
      trackSealGroups(footages, trackingOptions),
      populationReviews,
    ),
    [footages,trackingOptions,populationReviews],
  );
  /* Single-observation groups are real terms in the selected snapshot. They
     can open an honest one-checkpoint inspector even though no route exists
     yet; dropping them is how a new 140-animal merge vanished from the map. */
  const movementTracks = movementResult.tracks;
  const avoidanceResult = useMemo(()=>detectRegionAvoidance(footages),[footages]);
  const avoidanceRegions = useMemo<AvoidanceRegionOverlay[]>(()=>{
    return avoidanceResult.alerts.flatMap((alert,index)=>{
      const surveys=footages.filter(footage=>
        footage.siteRegion===alert.region
        && Number.isFinite(footage.center?.lat)
        && Number.isFinite(footage.center?.lng),
      );
      if(!surveys.length) return [];
      const center={
        lat:surveys.reduce((sum,survey)=>sum+survey.center.lat,0)/surveys.length,
        lng:surveys.reduce((sum,survey)=>sum+survey.center.lng,0)/surveys.length,
      };
      return [{
        id:`avoidance-${index}-${alert.region}`,
        region:alert.region,
        ...center,
        /* The archive stores effort area, not an exact boundary polygon. This
           review halo is intentionally a stable 35 km demo inspection zone;
           it does not pretend to be the surveyed footprint. */
        radiusKm:35,
        latestCount:alert.latest?.count ?? 0,
      }];
    });
  },[avoidanceResult.alerts,footages]);
  const populationSyncPayload = useMemo(()=>{
    const realIds=new Set(footages.filter(footage=>footage.source!=="test").map(footage=>footage.id));
    const tracks=movementResult.tracks.map(track=>({
      id:track.id,
      observations:track.observations.filter(observation=>realIds.has(observation.surveyId)).map(observation=>({
        id:observation.id,
        surveyId:observation.surveyId,
        observedAt:observation.observedAt,
        center:observation.center,
        size:observation.size,
        source:observation.source,
        memberIds:observation.memberIds,
      })),
    })).filter(track=>track.observations.length>0);
    return tracks.length ? JSON.stringify(tracks) : "";
  },[footages,movementResult]);
  useEffect(()=>{
    if(!populationSyncPayload) return;
    void syncTrackedPopulations(JSON.parse(populationSyncPayload));
  },[populationSyncPayload,syncTrackedPopulations]);
  const selectedMovementTrack = useMemo(
    ()=> movementTracks.find(track=>track.id===selectedMovementId) ?? null,
    [movementTracks,selectedMovementId],
  );
  const selectedMovementObservation = useMemo(()=>{
    if(!selectedMovementTrack) return null;
    return selectedMovementTrack.observations.find(o=>o.id===selectedObservationId)
      ?? selectedMovementTrack.observations[selectedMovementTrack.observations.length-1]
      ?? null;
  },[selectedMovementTrack,selectedObservationId]);
  const selectedPopulationName = useMemo(()=>{
    if(!selectedMovementTrack) return null;
    const observationIds=new Set(selectedMovementTrack.observations.map(o=>o.id));
    return populations.find(population=>
      population.observations.some(observation=>observationIds.has(observation.id)),
    )?.name ?? null;
  },[populations,selectedMovementTrack]);

  const selectedMovementFootage = useMemo(
    ()=>footagesRaw.find(footage=>footage.id===selectedMovementObservation?.surveyId) ?? null,
    [footagesRaw,selectedMovementObservation],
  );

  /* Brushing or changing matcher thresholds can remove/re-number tracks. Do
     not leave a detail card referring to a route that is no longer on screen. */
  useEffect(()=>{
    if(selectedMovementId && !selectedMovementTrack){
      selectPopulation(null);
    }
  },[selectedMovementId,selectedMovementTrack,selectPopulation]);

  /* Entering a route from analytics should reveal the complete chain, not
     leave the camera at basin scale with five cards stacked into one pixel.
     Include the forecast endpoint where one exists, but cap zoom so a short
     two-sighting track still has geographic context. */
  useEffect(()=>{
    const map=mapRef.current;
    if(!map || !mapLoaded || !selectedMovementTrack) return;
    /* Fit the measured history only. A seven-day extrapolation can be several
       times longer than the observed route (257 km in the demo); including it
       compresses nearby sightings until their cards overlap. The forecast
       remains drawn and can extend beyond the initial viewport. */
    const coords=selectedMovementTrack.observations.map(observation=>observation.center);
    if(!coords.length) return;
    let minLng=Infinity, minLat=Infinity, maxLng=-Infinity, maxLat=-Infinity;
    for(const point of coords){
      minLng=Math.min(minLng,point.lng); maxLng=Math.max(maxLng,point.lng);
      minLat=Math.min(minLat,point.lat); maxLat=Math.max(maxLat,point.lat);
    }
    try {
      map.stop();
      if(minLng===maxLng && minLat===maxLat){
        map.easeTo({ center:[minLng,minLat], zoom:8.5, duration:420 });
      } else {
        map.fitBounds([[minLng,minLat],[maxLng,maxLat]], {
          padding:{ top:80, right:340, bottom:90, left:80 },
          maxZoom:8.5,
          duration:520,
        });
      }
    } catch {}
  },[mapLoaded,selectedMovementId,selectedMovementTrack]);

  /* One pass over the brushed detections, shared by everything downstream.
     A false positive is a reviewed "not an animal" — it is out of the
     outline, out of the dots and out of the chip's geometry. */
  const placed = useMemo(()=>{
    const flat: Detection[] = [];
    const byFootage = new Map<string, Detection[]>();
    for(const d of detections){
      if(d.status==="false_positive") continue;
      flat.push(d);
      const arr = byFootage.get(d.footageId);
      if(arr) arr.push(d); else byFootage.set(d.footageId, [d]);
    }
    return { flat, byFootage };
  },[detections]);

  /* onMapReady arrives as an inline lambda from the page - a NEW identity on
     every parent render. Holding it in a ref keeps the map-creation effect on
     EMPTY deps; the old shape (useCallback deps -> effect deps) re-ran per
     render: cleanup removed the live map, the mapRef guard blocked recreating
     it, and the page was left with dead or doubled map instances. */
  const onMapReadyRef = useRef(onMapReady);
  useEffect(()=>{ onMapReadyRef.current = onMapReady; });

  const initMap = useCallback(async ()=>{
    if (!containerRef.current || mapRef.current) return;
    const ml = await import("maplibre-gl");
    /* Before the first Map spawns the worker pool: webpack mangles the
       library's own worker URL into one that serves index.html, and a map
       whose worker died renders every GeoJSON source as nothing, silently.
       The worker file is staged into public/ by tools/copy-maplibre-worker.mjs. */
    ((ml as any).setWorkerUrl ?? (ml as any).default?.setWorkerUrl)?.("/maplibre-gl-worker.js");
    MarkerCtorRef.current = (ml as any).Marker || (ml as any).default?.Marker;
    if (!containerRef.current || mapRef.current) return; // torn down while importing
    const MapCtor: any = (ml as any).Map || (ml as any).default?.Map;
    const NavCtrl: any = (ml as any).NavigationControl || (ml as any).default?.NavigationControl;
    const AttrCtrl: any = (ml as any).AttributionControl || (ml as any).default?.AttributionControl;
    if (!MapCtor) return;
    const map = new MapCtor({
      container: containerRef.current,
      style: DARK_STYLE,
      center: AKTAU,
      zoom: 6.8,
      maxBounds: [[42.5,34],[59,50.5]],
      // Past ~z18 even the deepest coastal imagery is pure overzoom mush and
      // the wheel only manufactures blur; the survey has nothing to say at
      // per-stone scale anyway.
      maxZoom: 18,
      attributionControl: false,
      dragPan: true,
      scrollZoom: true,
      dragRotate: false,
      touchZoomRotate: true,
      cooperativeGestures: false,
    });
    if (NavCtrl) map.addControl(new NavCtrl({ showCompass: false }), "bottom-right");
    if (AttrCtrl) map.addControl(new AttrCtrl({ compact: true }), "bottom-left");
    /* A survey chart with no scale bar asks the reader to guess how far apart
       two haul-outs are — on a product whose whole subject is distance, area
       and the 2 km that decides whether two visits are one place. Metric, and
       bottom-right above the zoom so it never lands on the attribution. */
    const ScaleCtrl: any = (ml as any).ScaleControl || (ml as any).default?.ScaleControl;
    if (ScaleCtrl) map.addControl(new ScaleCtrl({ maxWidth: 110, unit: "metric" }), "bottom-right");
    // ensure interactions enabled — overlay was blocking
    try{ map.dragPan.enable(); map.scrollZoom.enable(); map.doubleClickZoom.enable(); map.boxZoom.enable(); map.keyboard.enable(); }catch{}
    map.on("load", ()=> {
      map.addSource("footprints", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("population-movements", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("population-predictions", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("avoidance-regions", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("caspian-regions", {
        type:"geojson",
        data:{
          type:"FeatureCollection",
          features:Object.entries(CASPIAN_REGION_RINGS).map(([region,ring])=>({
            type:"Feature",
            geometry:{type:"Polygon",coordinates:[ring]},
            properties:{region},
          })),
        },
      });
      map.addSource("caspian-region-boundaries", {
        type:"geojson",
        data:{
          type:"FeatureCollection",
          features:Object.entries(CASPIAN_REGION_BOUNDARY_LINES).map(([id,boundary])=>({
            type:"Feature",
            geometry:{type:"LineString",coordinates:boundary},
            properties:{id},
          })),
        },
      });
      // Colonies as areas, animals as bare points. No per-dot count labels
      // anywhere — a dot is one animal, and drawing "1" on each was noise
      // left over from the mock era.
      map.addSource("colonies", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("animals", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      /* Barely-there value shifts let the eye read three water bodies before
         it reads a boundary. They deliberately stay achromatic: colour is
         reserved for live counts and warnings everywhere else in the chart. */
      map.addLayer({id:"caspian-region-fills",type:"fill",source:"caspian-regions",paint:{
        "fill-color":["match",["get","region"],"north","#aebbb8","central","#87939e","#aaa4ae"],
        "fill-opacity":["match",["get","region"],"north",0.04,"central",0.018,0.028],
        "fill-antialias":false,
      }});
      // Sites whose animals were counted but never georeferenced — see the
      // presence-disc note above the component.
      map.addSource("presence", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      // GL cannot read CSS vars, so the ramp is baked in: #e9edf2 is --ink.
      map.addLayer({ id: "footprints-line", type:"line", source:"footprints", paint:{ "line-color":"#e9edf2", "line-width":1, "line-opacity":0.3 } });
      map.addLayer({ id:"footprints-fill", type:"fill", source:"footprints", paint:{ "fill-color":"#e9edf2", "fill-opacity":0.04 } });
      map.addLayer({id:"caspian-region-boundary-glow",type:"line",source:"caspian-region-boundaries",paint:{
        "line-color":"#9aa5b1",
        "line-width":5,
        "line-opacity":0.07,
      }});
      map.addLayer({id:"caspian-region-boundary-lines",type:"line",source:"caspian-region-boundaries",paint:{
        "line-color":"#85909c",
        "line-width":1.1,
        "line-opacity":0.5,
        "line-dasharray":[1.5,3],
      }});
      /* A regional avoidance signal is an area to inspect, not an inferred
         animal trail. Keep it beneath every observation card and state the
         uncertainty with a translucent fill and dashed boundary. */
      map.addLayer({ id:"avoidance-region-fill", type:"fill", source:"avoidance-regions", paint:{
        "fill-color":"#e0685e",
        "fill-opacity":0.12,
      }});
      map.addLayer({ id:"avoidance-region-line", type:"line", source:"avoidance-regions", paint:{
        "line-color":"#e0685e",
        "line-width":2,
        "line-opacity":0.9,
        "line-dasharray":[3,2],
      }});
      // Dashed on purpose: this is a nearest-similar-group hypothesis between
      // discrete observations, not a GPS track or proof of animal identity.
      // A wide invisible hit target keeps a two-pixel route selectable without
      // making it visually heavy.
      map.addLayer({ id:"population-movement-hit", type:"line", source:"population-movements", filter:["==",["geometry-type"],"LineString"], paint:{
        "line-width":14,
        "line-opacity":0.01,
      }});
      map.addLayer({ id:"population-movement-lines", type:"line", source:"population-movements", filter:["==",["geometry-type"],"LineString"], paint:{
        "line-color":"#74b294",
        "line-width":["case",["==",["get","selected"],true],4,2],
        "line-opacity":["case",["==",["get","dimmed"],true],0.14,0.88],
        "line-dasharray":[3,2],
      }});
      map.addLayer({ id:"population-movement-points", type:"circle", source:"population-movements", filter:["==",["geometry-type"],"Point"], paint:{
        "circle-radius":["case",["==",["get","selectedObservation"],true],7,["==",["get","selected"],true],5,3.5],
        "circle-color":["case",["==",["get","selectedObservation"],true],"#74b294","#101415"],
        "circle-stroke-color":"#74b294",
        "circle-stroke-width":["case",["==",["get","selected"],true],2,1.25],
        "circle-opacity":["case",["==",["get","dimmed"],true],0.18,0.98],
      }});
      // Forecast geometry is a separate source: absence of prediction data is
      // represented by an empty collection rather than a fabricated endpoint.
      map.addLayer({ id:"population-prediction-line", type:"line", source:"population-predictions", filter:["==",["geometry-type"],"LineString"], paint:{
        "line-color":"#e0a13c",
        "line-width":2.5,
        "line-opacity":0.9,
        "line-dasharray":[1,2],
      }});
      map.addLayer({ id:"population-prediction-point", type:"circle", source:"population-predictions", filter:["==",["geometry-type"],"Point"], paint:{
        "circle-radius":6,
        "circle-color":"#e0a13c",
        "circle-opacity":0.95,
        "circle-stroke-color":"#101415",
        "circle-stroke-width":2,
      }});
      // Colony outline: the haul-out drawn as an area, not a soup of dots.
      // Appears from mid zoom; far out the chip alone carries the story.
      //
      // The amber is gone. This design spends ONE colour, and it spends it on
      // the count in the chip — an amber wash under every colony was a second
      // signal smeared across the whole coast, competing with the figure it
      // sits beneath. The outline is ink now and says what it has to say with
      // value: a hairline over a dark fill, stepping up in width and opacity
      // for the selected sortie.
      map.addLayer({ id:"colony-fill", type:"fill", source:"colonies", minzoom: ZOOM_COLONY, paint:{
        "fill-color":"#e9edf2",
        "fill-opacity":0.07, // white reads far hotter than the old tint — keep in sync with the pin toggle below
      }});
      map.addLayer({ id:"colony-line", type:"line", source:"colonies", minzoom: ZOOM_COLONY, paint:{
        "line-color":"#e9edf2",
        "line-width": ["case",["==",["get","selected"],true], 2, 1],
        "line-opacity": ["case",["==",["get","selected"],true], 1, 0.55],
      }});
      /* The presence disc. It carries the signal colour because it stands in
         for a count — but at a seventh of the fill opacity a hull gets, and
         with a DASHED edge: a solid line would claim a surveyed boundary. GL
         cannot read CSS vars, so #3fd8a3 is --accent baked in. minzoom 7: at
         basin zoom the disc is sub-pixel noise under its own chip; it fades in
         as you approach and is plainly there by ZOOM_COLONY. */
      map.addLayer({ id:"presence-fill", type:"fill", source:"presence", minzoom: 7, paint:{
        "fill-color":"#3fd8a3",
        "fill-opacity":0.07,
      }});
      map.addLayer({ id:"presence-line", type:"line", source:"presence", minzoom: 7, paint:{
        "line-color":"#3fd8a3",
        "line-width":1.5,
        "line-opacity":0.55,
        "line-dasharray":[2,2],
      }});
      // Individual animals only at close zoom, bare dots, no labels. A verdict
      // is semantic and keeps its colour: validated is --good (#3fd8a3), and
      // an unreviewed dot is plain ink.
      map.addLayer({ id:"animal-dots", type:"circle", source:"animals", minzoom: ZOOM_ANIMALS, paint:{
        "circle-radius": 3.5,
        "circle-color": ["case",["==",["get","status"],"validated"],"#3fd8a3","#e9edf2"],
        "circle-stroke-color": "rgba(0,0,0,0.6)",
        "circle-stroke-width": 1,
        "circle-opacity": 1
      }});

      setMapLoaded(true);
      onMapReadyRef.current?.(map);

      // Pin-mode click handler. The map is created once (the init guard above
      // bails on re-runs), so anything these closures capture is frozen at
      // first render - `pinMode` here was ALWAYS false and manual pinning
      // never registered a single point. Read the store at event time, the
      // way the pinPoints line below already had to.
      map.on("click", (e: any)=>{
        if (useFootageStore.getState().pinMode) {
          // One anchor, not a drawn path: every click MOVES the point. The
          // old append built a ring, the ingest fabricated a flight track out
          // of it, and the animals scattered around the ring. The anchor is
          // the centre of the shot; the engine lays the animals out around it
          // by their true pixel positions.
          /* Three decimals, ~110 m — the precision one click supports. Four
             decimals is ~11 m, a claim no gesture at basin zoom can make, and
             the GeoJSON, the CSV and the PDF would all print it as if the
             coordinate had been surveyed. The zoom goes with it so the
             sortie's note can say how close the operator actually was. */
          setPinPoints([{ t: 0, lat: round3(e.lngLat.lat), lng: round3(e.lngLat.lng) }]);
          try { useIngestStore.getState().notePin("click", map.getZoom()); } catch {}
          // Centre on the anchor: the acknowledgement is the map itself
          // moving, so the bullseye can never land off-screen or under a
          // panel and read as "nothing happened".
          try { map.easeTo({ center: e.lngLat, duration: 250 }); } catch {}
        }
      });
      map.on("click","animal-dots",(e: any)=>{
        if(useFootageStore.getState().pinMode) return;
        const fid = (e.features?.[0]?.properties as any)?.fid as string;
        if(fid) select(fid);
      });
      map.on("mouseenter","animal-dots",()=> map.getCanvas().style.cursor="pointer");
      map.on("mouseleave","animal-dots",()=> map.getCanvas().style.cursor= useFootageStore.getState().pinMode?"crosshair":"");
    });
    mapRef.current = map;
    /* Dev-only handle for driving the camera in automated verification. */
    if (process.env.NODE_ENV === "development") (window as any).__mainMap = map;
    // The container's width changes with every panel toggle, but the map was
    // created at whatever size the first paint happened to have - 400x300 on
    // a cold load. Without resize() the canvas keeps that stale geometry: the
    // chart LOOKS full-width while clicks unproject through the old 400px
    // transform, landing the pin anchor far from the cursor. That is the
    // "clicked and nothing appeared" bug in one line.
    const ro = new ResizeObserver(()=> { try { map.resize(); } catch {} });
    if (containerRef.current) ro.observe(containerRef.current);
    roRef.current = ro;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roRef = useRef<ResizeObserver | null>(null);
  /* The anchor is a DOM marker, not a GL circle layer: DOM renders under any
     GL backend (headless/software included), pulses via CSS, and cannot be
     buried by style reloads. Held here so the update effect can move it. */
  const anchorMarkerRef = useRef<any>(null);
  const MarkerCtorRef = useRef<any>(null);
  useEffect(()=>{
    initMap();
    return ()=> {
      try { roRef.current?.disconnect(); } catch {}
      try { anchorMarkerRef.current?.remove(); } catch {}
      anchorMarkerRef.current = null;
      /* No `window.__sealvMap` to drop any more. It was a global handle on the
         whole map — every source, every tile, the GL context — published for
         LeftPanel to easeTo() through, and LeftPanel now dispatches `flyto`
         instead. Nothing read it, so it was a live reference to a torn-down
         map waiting for its first stale reader. */
      try { mapRef.current?.remove(); } catch {}
      roRef.current = null;
      mapRef.current = null;   // the guard must reopen for the next mount
      setMapLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const pollutionDisplayData = useMemo(
    () => pollutionDisplay(pollution, pollutionReferenceTime, selectedPollutionId),
    [pollution, pollutionReferenceTime, selectedPollutionId],
  );
  const pollutionUncertaintyData = useMemo(
    () => pollutionUncertainty(pollutionDisplayData),
    [pollutionDisplayData],
  );
  const selectedPollution = useMemo(
    () => pollution.features.find(feature => feature.properties.id === selectedPollutionId) ?? null,
    [pollution.features, selectedPollutionId],
  );
  useEffect(()=>{
    if(selectedSiteKey || selectedMovementId) setSelectedPollutionId(null);
  },[selectedSiteKey,selectedMovementId]);
  useEffect(()=>{
    if(
      selectedPollutionId
      && !pollutionDisplayData.features.some(feature => feature.properties.id === selectedPollutionId)
    ) setSelectedPollutionId(null);
  },[pollutionDisplayData.features,selectedPollutionId]);

  /* Initial evidence arrives once; cursor-based deltas refresh only while this
     tab is visible. Updating the GeoJSON source preserves camera, layers,
     checkpoint, and inspector selection. */
  useEffect(()=>{
    const controller = new AbortController();
    let stopped = false;
    let loading = false;
    let initialized = false;
    let cursor = 0;
    const refreshEvidence = async () => {
      if(stopped || loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        if(!initialized){
          const collection = await fetchPollution({
            bbox: "46,36,55,48",
            limit: 2000,
            signal: controller.signal,
          });
          if(stopped) return;
          cursor = collection.cursor ?? 0;
          initialized = true;
          setPollution(collection);
        } else {
          let hasMore = true;
          while(hasMore && !stopped){
            const changes = await fetchPollutionChanges(cursor, {
              bbox: "46,36,55,48",
              limit: 500,
              signal: controller.signal,
            });
            cursor = changes.cursor ?? cursor;
            hasMore = Boolean(changes.has_more);
            setPollution(current => mergePollution(current, changes));
          }
        }
        setPollutionError(false);
      } catch(error) {
        if(error instanceof DOMException && error.name === "AbortError") return;
        setPollutionError(true);
      } finally {
        loading = false;
      }
    };
    const refreshHealth = async () => {
      if(stopped || document.visibilityState !== "visible") return;
      try {
        const status = await fetchPollutionStatus(controller.signal);
        const statuses = status.summary.statuses;
        setPollutionHealth({
          failed: (statuses.error ?? 0) + (statuses.unavailable ?? 0) + (statuses.partial ?? 0),
          stale: status.summary.stale ?? 0,
        });
      } catch(error) {
        if(error instanceof DOMException && error.name === "AbortError") return;
      }
    };
    const refreshVisible = () => {
      void refreshEvidence();
      void refreshHealth();
    };
    setPollutionError(false);
    refreshVisible();
    const interval = window.setInterval(refreshVisible, 60_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  },[]);

  /* Reported points, analyst polygons, and metre-based uncertainty are three
     distinct claims. They get separate layers instead of one oversized dot. */
  useEffect(()=>{
    const map:any = mapRef.current;
    if(!map || !mapLoaded) return;
    const source = map.getSource("pollution-evidence");
    if(source) source.setData(pollutionDisplayData);
    else map.addSource("pollution-evidence", { type:"geojson", data:pollutionDisplayData });
    const uncertaintySource = map.getSource("pollution-uncertainty");
    if(uncertaintySource) uncertaintySource.setData(pollutionUncertaintyData);
    else map.addSource("pollution-uncertainty", { type:"geojson", data:pollutionUncertaintyData });

    if(!map.getLayer("pollution-uncertainty-fill")) map.addLayer({
      id:"pollution-uncertainty-fill", type:"fill", source:"pollution-uncertainty",
      paint:{ "fill-color":["get","color"], "fill-opacity":0.045 },
    });
    if(!map.getLayer("pollution-uncertainty-line")) map.addLayer({
      id:"pollution-uncertainty-line", type:"line", source:"pollution-uncertainty",
      paint:{
        "line-color":["get","color"],
        "line-opacity":0.72,
        "line-width":["case",["boolean",["get","selected"],false],2,1],
        "line-dasharray":[3,2],
      },
    });
    if(!map.getLayer("pollution-polygon-fill")) map.addLayer({
      id:"pollution-polygon-fill", type:"fill", source:"pollution-evidence",
      filter:["==",["geometry-type"],"Polygon"],
      paint:{
        "fill-color":["get","color"],
        "fill-opacity":["case",["boolean",["get","selected"],false],0.32,0.18],
      },
    });
    if(!map.getLayer("pollution-polygon-line")) map.addLayer({
      id:"pollution-polygon-line", type:"line", source:"pollution-evidence",
      filter:["==",["geometry-type"],"Polygon"],
      paint:{
        "line-color":["get","color"],
        "line-opacity":0.94,
        "line-width":["case",["boolean",["get","selected"],false],3,1.5],
      },
    });
    if(!map.getLayer("pollution-point-halo")) map.addLayer({
      id:"pollution-point-halo", type:"circle", source:"pollution-evidence",
      filter:["==",["geometry-type"],"Point"],
      paint:{
        "circle-color":["get","color"],
        "circle-radius":["case",["boolean",["get","selected"],false],14,10],
        "circle-opacity":0.2,
      },
    });
    if(!map.getLayer("pollution-point")) map.addLayer({
      id:"pollution-point", type:"circle", source:"pollution-evidence",
      filter:["==",["geometry-type"],"Point"],
      paint:{
        "circle-color":["get","color"],
        "circle-radius":["case",["boolean",["get","selected"],false],7,5],
        "circle-opacity":0.92,
        "circle-stroke-color":"#0f1115",
        "circle-stroke-width":1,
      },
    });
  },[pollutionDisplayData,pollutionUncertaintyData,mapLoaded]);

  useEffect(()=>{
    const map:any = mapRef.current;
    const tip = tipRef.current;
    if(!map || !mapLoaded || !tip) return;
    const layers = ["pollution-point","pollution-polygon-fill"];
    const move = (event:any)=>{
      if(pinMode) return;
      const properties = event.features?.[0]?.properties ?? {};
      tip.style.display="block";
      tip.style.left=`${event.point.x+12}px`;
      tip.style.top=`${event.point.y-12}px`;
      tip.textContent=[properties.root_cause || properties.kind, properties.source_name || properties.source_id]
        .filter(Boolean).join(" · ");
      map.getCanvas().style.cursor="pointer";
    };
    const leave = ()=>{
      tip.style.display="none";
      if(!pinMode) map.getCanvas().style.cursor="";
    };
    const click = (event:any)=>{
      if(pinMode) return;
      const id=String(event.features?.[0]?.properties?.id ?? "");
      if(!id) return;
      tip.style.display="none";
      map.getCanvas().style.cursor="";
      setSelectedPollutionId(id);
      select(null);
      selectPopulation(null);
      onPollutionFocus?.();
    };
    for(const layer of layers){
      map.on("mousemove",layer,move);
      map.on("mouseleave",layer,leave);
      map.on("click",layer,click);
    }
    return ()=>{
      for(const layer of layers){
        try{
          map.off("mousemove",layer,move);
          map.off("mouseleave",layer,leave);
          map.off("click",layer,click);
        }catch{}
      }
    };
  },[mapLoaded,pinMode,onPollutionFocus,select,selectPopulation]);

  useEffect(()=>{
    const map:any=mapRef.current;
    if(!map||!mapLoaded) return;
    const visibility=showPollution && !pinMode ? "visible" : "none";
    for(const layer of [
      "pollution-uncertainty-fill","pollution-uncertainty-line",
      "pollution-polygon-fill","pollution-polygon-line",
      "pollution-point-halo","pollution-point",
    ]){
      try{ if(map.getLayer(layer)) map.setLayoutProperty(layer,"visibility",visibility); }catch{}
    }
    if(visibility==="none" && tipRef.current) tipRef.current.style.display="none";
  },[showPollution,pinMode,mapLoaded]);

  // update cursor when pinMode toggles; in pin mode the data layers step
  // back so the one thing being placed is the loudest thing on the chart
  useEffect(()=>{
    const m = mapRef.current; if (!m) return;
    m.getCanvas().style.cursor = pinMode ? "crosshair" : "";
    for (const [id, prop, on, off] of [
      ["colony-fill","fill-opacity",0.07,0.02],
      ["colony-line","line-opacity",0.55,0.18],
      ["animal-dots","circle-opacity",1,0.25],
      ["population-movement-lines","line-opacity",["case",["==",["get","dimmed"],true],0.14,0.88],0.2],
      ["population-movement-points","circle-opacity",["case",["==",["get","dimmed"],true],0.18,0.98],0.2],
      ["population-prediction-line","line-opacity",0.9,0.18],
      ["population-prediction-point","circle-opacity",0.95,0.18],
      ["avoidance-region-fill","fill-opacity",0.12,0.03],
      ["avoidance-region-line","line-opacity",0.9,0.18],
    ] as const) {
      try {
        m.setPaintProperty(id, prop, pinMode ? off : on);
      } catch { /* layer not created yet - the load handler sets defaults */ }
    }
  }, [pinMode, mapLoaded]);

  /* MapLibre labels its own controls in English. This UI is Kazakh by default,
     so the zoom buttons and the attribution toggle are re-labelled from the
     dictionary — and again whenever the language switches (`t` is a new
     identity per language). Until `load` fires the whole map is behind the
     loading overlay, so the library's English never reaches the screen. */
  useEffect(()=>{
    const root = containerRef.current; if(!root || !mapLoaded) return;
    const label = (selector: string, text: string)=>{
      const el = root.querySelector(selector);
      if(!el) return;
      el.setAttribute("title", text);
      el.setAttribute("aria-label", text);
    };
    label(".maplibregl-ctrl-zoom-in", t("map.zoomIn"));
    label(".maplibregl-ctrl-zoom-out", t("map.zoomOut"));
    label(".maplibregl-ctrl-attrib-button", t("map.attribution"));

  }, [mapLoaded, t]);

  // satellite toggle: swap raster layer
  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    if (satellite) {
      if (map.getLayer("osm")) map.setLayoutProperty("osm","visibility","none");
      if (!map.getSource("esri")) {/* already in style */}
      if (!map.getLayer("esri-raster")) {
        map.addLayer({ id:"esri-raster", type:"raster", source:"esri", paint:{ "raster-opacity":0.95, "raster-brightness-max":0.6, "raster-saturation":-0.35 } }, "caspian-region-fills");
      } else map.setLayoutProperty("esri-raster","visibility","visible");
      /* One track colour, both basemaps. The old pair — a hazard yellow over
         imagery, a cyan over the dark tiles — were two more hues than this
         chart has, and neither carried any meaning the line did not already
         have. A flight track is context, so it stays ink and buys its
         legibility over bright imagery with opacity instead. */
      try{
        map.setPaintProperty("footprints-line","line-color","#e9edf2");
        map.setPaintProperty("footprints-line","line-opacity",0.55);
      }catch{}
    } else {
      if (map.getLayer("osm")) map.setLayoutProperty("osm","visibility","visible");
      if (map.getLayer("esri-raster")) map.setLayoutProperty("esri-raster","visibility","none");
      if (mapLoaded) try{
        map.setPaintProperty("footprints-line","line-color","#e9edf2");
        map.setPaintProperty("footprints-line","line-opacity",0.3);
      }catch{}
    }
  }, [satellite, mapLoaded]);

  /* Flight tracks. No `selected` property: no layer reads it (footprints-line
     paints one colour), and selection styling lives in the SVG overlay — so
     carrying it here only tied this push to every list click. */
  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    const src = map.getSource("footprints") as any;
    if(!src) return;
    src.setData({
      type:"FeatureCollection",
      features: showTracks ? footages.map(f=>({
        type:"Feature",
        geometry:{ type:"LineString", coordinates: f.track.map(p=>[p.lng, p.lat]) },
        properties:{ id:f.id }
      })) : []
    });
  }, [footages, showTracks, mapLoaded]);

  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    const src=map.getSource("avoidance-regions") as any;
    if(!src) return;
    src.setData({
      type:"FeatureCollection",
      features:avoidanceRegions.map(region=>({
        type:"Feature",
        geometry:{type:"Polygon",coordinates:[circleRing(region,region.radiusKm)]},
        properties:{id:region.id,region:region.region,latestCount:region.latestCount},
      })),
    });
  },[avoidanceRegions,mapLoaded]);

  /* Group positions in the GL layer mirror the disclosure state of the DOM
     cards. Collapsed groups expose only their latest observation. Selecting a
     group reveals its dated history; the links themselves are DOM lines, not
     a second geographic trail underneath them. */
  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    const src = map.getSource("population-movements") as any;
    if(!src) return;
    const features: any[] = [];
    for(const track of movementTracks){
      const selected = track.id===selectedMovementId;
      const dimmed = selectedMovementId!==null && !selected;
      const visibleObservations = selected
        ? track.observations
        : standingFootageIds
          ? track.observations.filter(observation=>standingIdSet.has(observation.surveyId))
          : track.observations.slice(-1);
      for(const o of visibleObservations){
        const i=track.observations.indexOf(o);
        features.push({
          type:"Feature",
          geometry:{ type:"Point", coordinates:[o.center.lng,o.center.lat] },
          properties:{
            id:track.id,
            observationId:o.id,
            order:i+1,
            size:o.size,
            observedAt:o.observedAt,
            selected,
            dimmed,
            selectedObservation:selected && o.id===selectedMovementObservation?.id,
          },
        });
      }
    }
    src.setData({ type:"FeatureCollection", features });
  },[movementTracks,mapLoaded,selectedMovementId,selectedMovementObservation,standingFootageIds,standingIdSet]);

  /* Only the selected group's forecast is loud enough to draw. The last
     observed point remains green; the unobserved continuation is amber and
     comes from the optional prediction payload parsed by predictionOf(). */
  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    const src = map.getSource("population-predictions") as any;
    if(!src) return;
    const last = selectedMovementTrack?.observations[selectedMovementTrack.observations.length-1];
    const prediction = selectedMovementTrack ? predictionOf(selectedMovementTrack) : null;
    if(!selectedMovementTrack || !last || !prediction){
      src.setData(EMPTY_FC);
      return;
    }
    src.setData({
      type:"FeatureCollection",
      features:[
        {
          type:"Feature",
          geometry:{ type:"LineString", coordinates:[[last.center.lng,last.center.lat],[prediction.center.lng,prediction.center.lat]] },
          properties:{ id:selectedMovementTrack.id, predicted:true, confidence:prediction.confidence ?? "" },
        },
        {
          type:"Feature",
          geometry:{ type:"Point", coordinates:[prediction.center.lng,prediction.center.lat] },
          properties:{ id:selectedMovementTrack.id, predicted:true, predictedAt:prediction.predictedAt ?? "" },
        },
      ],
    });
  },[mapLoaded,selectedMovementTrack]);

  /* One map-level hit test avoids competing click handlers when an observed
     point lies directly on its route. Points win, then prediction endpoints,
     then the wide route hit target. */
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    const layers=["population-movement-points","population-prediction-point","population-movement-hit"];
    const hitsAt=(point:any)=>{
      try { return map.queryRenderedFeatures(point,{ layers }); } catch { return []; }
    };
    const onClick=(e:any)=>{
      if(useFootageStore.getState().pinMode) return;
      const hit=hitsAt(e.point)?.[0];
      const id=hit?.properties?.id as string | undefined;
      if(!id){
        selectPopulation(null);
        return;
      }
      const track=movementTracks.find(candidate=>candidate.id===id);
      if(!track) return;
      const observationId=hit.properties?.observationId as string | undefined;
      const observation=track.observations.find(candidate=>candidate.id===observationId)
        ?? track.observations[track.observations.length-1]
        ?? null;
      onMovementFocus?.();
      selectPopulation(id,observation?.id ?? null);
    };
    const onMove=(e:any)=>{
      if(useFootageStore.getState().pinMode) return;
      map.getCanvas().style.cursor=hitsAt(e.point).length ? "pointer" : "";
    };
    map.on("click",onClick);
    map.on("mousemove",onMove);
    return ()=>{
      try { map.off("click",onClick); map.off("mousemove",onMove); } catch {}
    };
  },[mapLoaded,movementTracks,selectPopulation,onMovementFocus]);

  /* The pinned anchor: one DOM marker, moved or removed per state. Its own
     effect — it used to ride along with the whole data push, so placing a pin
     re-hulled and re-uploaded the entire season. */
  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    if (pinMode && pinPoints.length > 0 && MarkerCtorRef.current) {
      const p0 = pinPoints[0];
      if (!anchorMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "pin-anchor-marker";
        el.setAttribute("data-pin-anchor", "1");
        anchorMarkerRef.current = new MarkerCtorRef.current({ element: el, anchor: "center" });
      }
      anchorMarkerRef.current.setLngLat([p0.lng, p0.lat]).addTo(map);
    } else if (anchorMarkerRef.current) {
      anchorMarkerRef.current.remove();
    }
  }, [pinMode, pinPoints, mapLoaded]);

  /* Colony outlines: concave hull buffered ~25 m so the line breathes around
     the animals instead of hugging them. <3 usable points = no polygon
     exists, and we do not invent one — the chip alone stands.

     Cached per sortie by point-set signature: a hull is recomputed only when
     that sortie's placed points actually change. Eviction is keyed on the
     UNBRUSHED season so dragging the timeline does not throw hulls away and
     pay for them again on the way back. */
  const hullCacheRef = useRef<Map<string, { sig: string; ring: number[][] | null }>>(new Map());
  const colonyRingsRef = useRef<ColonyRing[]>([]);
  /* Selection is a property, not geometry: colony-line already switches width
     and opacity on `selected`, so re-pushing the CACHED rings with a new flag
     is the whole cost of selecting a sortie. */
  const pushColonies = useCallback((selId: string | null)=>{
    const csrc = mapRef.current?.getSource?.("colonies") as any;
    if(!csrc) return;
    csrc.setData({
      type:"FeatureCollection",
      features: colonyRingsRef.current.map(c=>({
        type:"Feature",
        geometry:{ type:"Polygon", coordinates:[c.ring] },
        properties:{ fid:c.fid, selected: c.fid===selId }
      }))
    });
  },[]);

  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    const csrc = map.getSource("colonies") as any;
    const asrc = map.getSource("animals") as any;
    if(!csrc || !asrc) return;
    if(!showColonies){
      colonyRingsRef.current = [];
      csrc.setData(EMPTY_FC); asrc.setData(EMPTY_FC);
      return;
    }
    const cache = hullCacheRef.current;
    const rings: ColonyRing[] = [];
    for(const f of footages){
      const pts = placed.byFootage.get(f.id);
      if(!pts || pts.length < 3) continue;
      const sig = pointsSignature(pts);
      let hit = cache.get(f.id);
      if(!hit || hit.sig !== sig){
        const hull = expandHull(colonyHull(pts), 25);
        let ring: number[][] | null = null;
        if(hull.length >= 3){
          ring = hull.map(p=>[p.lng, p.lat]);
          ring.push(ring[0]); // GeoJSON rings close explicitly
        }
        hit = { sig, ring };
        cache.set(f.id, hit);
      }
      if(hit.ring) rings.push({ fid: f.id, ring: hit.ring });
    }
    const live = new Set(footagesRaw.map(f=>f.id));
    for(const key of Array.from(cache.keys())) if(!live.has(key)) cache.delete(key);
    colonyRingsRef.current = rings;
    pushColonies(useFootageStore.getState().selectedId);

    asrc.setData({
      type:"FeatureCollection",
      // No `count` property: no layer reads it, and it rode along on every
      // one of up to ~2000 points per sortie.
      features: placed.flat.map(d=>({
        type:"Feature",
        geometry:{ type:"Point", coordinates:[d.lng, d.lat] },
        properties:{ detId:d.id, fid:d.footageId, status:d.status }
      }))
    });
  }, [footages, footagesRaw, placed, showColonies, mapLoaded, pushColonies]);

  // Selection alone never touches the animal points or the hull maths.
  useEffect(()=>{
    if(!mapLoaded) return;
    pushColonies(selectedId);
  }, [selectedId, mapLoaded, pushColonies]);

  // fly to selected now handled by click handlers (chip → fitBounds, list → center) to avoid double-ease fighting drag

  /* Auto-fit when the set of visible sorties changes (so colonies land on
     screen at z~7 instead of off-screen at z9.2). Keyed on the sortie IDS,
     not on the array lengths: brushing the timeline onto a DIFFERENT set of
     the same size used to leave the camera parked over sorties that were no
     longer drawn. */
  const fitKey = useMemo(()=> footages.map(f=>f.id).join(","), [footages]);
  const standingFitKey = useMemo(()=> (standingFootageIds ?? []).join(","),[standingFootageIds]);
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    /* Not while the archive is still arriving. Hydration commits each sortie
       to the store the moment its points resolve, so during boot fitKey takes
       a new value per merged run — five self-cancelling 520 ms fitBounds
       animations on today's fixture, and one per sortie at the design target
       of hundreds per season. hydrating is in the deps, so the camera settles
       exactly once, on the finished set, the moment it flips false. */
    if (hydrating) return;
    /* A focused movement track owns the camera. `selectedId` covers sortie
       selection only; without the second guard this all-season fit ran after
       the route fit and immediately compressed the linked cards back to basin
       scale. */
    if (fitKey && !selectedId && !selectedMovementTrack) {
      // compute bounds of all tracks + detections
      let minLng=180, minLat=90, maxLng=-180, maxLat=-90;
      for(const f of footages){ for(const p of f.track){ minLng=Math.min(minLng,p.lng); maxLng=Math.max(maxLng,p.lng); minLat=Math.min(minLat,p.lat); maxLat=Math.max(maxLat,p.lat); } }
      for(const d of detections){ minLng=Math.min(minLng,d.lng); maxLng=Math.max(maxLng,d.lng); minLat=Math.min(minLat,d.lat); maxLat=Math.max(maxLat,d.lat); }
      /* Aggregate group cards can be positioned from a survey centre even
         when the sortie has no usable flight line or per-animal points. They
         still belong to the timestamp state, so their own measured centres
         participate in the camera fit instead of landing just outside it. */
      for(const track of movementTracks){
        for(const observation of track.observations){
          if(standingFootageIds && !standingIdSet.has(observation.surveyId)) continue;
          minLng=Math.min(minLng,observation.center.lng); maxLng=Math.max(maxLng,observation.center.lng);
          minLat=Math.min(minLat,observation.center.lat); maxLat=Math.max(maxLat,observation.center.lat);
        }
      }
      if (isFinite(minLng)) {
        const pad = 0.15;
        /* Bounds protect card rectangles, not only their centre points. The
           southern card needs extra room below its coordinate; otherwise the
           state is numerically present but its plate lands just off-screen. */
        try { map.stop(); map.fitBounds([[minLng-pad, minLat-pad],[maxLng+pad, maxLat+pad]], { padding:{top:64,right:64,bottom:176,left:64}, duration:520, maxZoom:ZOOM_COLONY }); } catch{}
      }
    }
    /* `footages` and `detections` are read latest ON PURPOSE and kept out of
       the deps: the camera must move when the SET of sorties changes (that is
       fitKey), never because a verdict click handed us a new `detections`
       array identity — that would yank the map out from under the review. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[fitKey,standingFitKey,mapLoaded,selectedId,selectedMovementTrack,hydrating]);

  /* DOM overlay — tracks and colony chips, guaranteed visible even if GL
     layers/glyphs fail. Everything that depends only on the DATA is computed
     here, once; the move handler below is left with nothing but projection. */
  const chipLayerRef = useRef<HTMLDivElement>(null);
  const [overlayChips, setOverlayChips] = useState<ColonyChip[]>([]);
  const [overlayTracks, setOverlayTracks] = useState<Array<{pts:Array<{x:number,y:number}>, id:string}>>([]);
  const [overlayMovementCards, setOverlayMovementCards] = useState<MovementObservationCard[]>([]);
  const [overlayAvoidanceRegions,setOverlayAvoidanceRegions]=useState<ProjectedAvoidanceRegion[]>([]);
  const [overlayRegionLabels,setOverlayRegionLabels]=useState<Array<{region:(typeof CASPIAN_REGIONS)[number];x:number;y:number}>>([]);

  // A pinned anchor is a single point — no path to overlay.
  const trackLines = useMemo(()=>{
    if(!showTracks) return [] as Array<{ id:string; coords:[number,number][] }>;
    const out: Array<{ id:string; coords:[number,number][] }> = [];
    for(const f of footages){
      const coords: [number,number][] = [];
      for(const p of f.track){
        if(Number.isFinite(p.lat) && Number.isFinite(p.lng)) coords.push([p.lng, p.lat]);
      }
      if(coords.length>1) out.push({ id:f.id, coords });
    }
    return out;
  },[footages, showTracks]);

  /* Where the chips want to sit, in world coordinates — the caller's sites,
     filtered to the ones that can be placed. The "colonies" toggle still hides
     them, because a chip IS the colony reading at season zoom and turning the
     colonies off and leaving twelve counts floating over the water was never
     what that switch meant.

     Nothing is computed from the sortie list here any more. The season's
     arithmetic — which visit is standing, what the band is, whether the place
     has a name — belongs to the helpers SeasonMode calls, and duplicating any
     part of it in the renderer is how the map came to print a number the panel
     beside it disagreed with. */
  const chipAnchors = useMemo(()=>{
    if(!showColonies) return [] as SiteChip[];
    return (siteChips ?? []).filter(s=> Number.isFinite(s.lat) && Number.isFinite(s.lng));
  },[siteChips, showColonies]);

  /* Presence discs, pushed on the same cadence as the colonies/animals sources:
     whenever the chips or the placed detections change. A site qualifies only
     when it HAS a count and none of its sorties contributed a single placed
     detection — sites with real positions keep their dots and hulls and get no
     disc, because the disc is an admission that the extent is unknown, not a
     decoration. Nothing here invents a coordinate: the centre is the site's own
     centroid and the radius is a function of the count alone. */
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    const src = map.getSource("presence") as any;
    if(!src) return;
    src.setData({
      type:"FeatureCollection",
      features: chipAnchors
        .filter(s=> s.count!=null && s.count>0 &&
          /* The `-agg` marker is one synthetic dot standing in for a run whose
             animals could not be placed — the very case the disc exists for.
             Only a REAL per-animal detection means the extent is measured. */
          !s.footageIds.some(id=>
            (placed.byFootage.get(id) ?? []).some(d=> !d.id.endsWith("-agg"))))
        .map(s=>({
          type:"Feature",
          geometry:{ type:"Polygon", coordinates:[presenceRing(s.lat, s.lng, presenceRadius(s.count as number))] },
          properties:{ key:s.key, count:s.count }
        }))
    });
  },[chipAnchors, placed, mapLoaded]);

  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    /* Coalesce through one animation frame. MapLibre fires `move` once per
       frame while dragging, and the old handler re-grouped every detection
       and re-ran colonyBounds on each of them; now a frame costs a few dozen
       project() calls. rAF also parks the work entirely while the tab is in
       the background — which the old setInterval(600) never did. */
    let frame = 0;
    const update = ()=>{
      frame = 0;
      const m = mapRef.current; if(!m) return;
      try {
        const tTracks = trackLines.map(l=>({
          id: l.id,
          pts: l.coords.map(c=>{ const pr=m.project(c); return { x:pr.x, y:pr.y }; }),
        }));
        setOverlayTracks(prev=> sameTracks(prev, tTracks) ? prev : tTracks);
        const regionLabels=CASPIAN_REGIONS.map(region=>{
          const anchor=CASPIAN_REGION_LABEL_POINTS[region];
          const point=m.project([anchor.lng,anchor.lat]);
          return {region,x:point.x,y:point.y};
        });
        setOverlayRegionLabels(prev=>{
          const same=prev.length===regionLabels.length && prev.every((label,index)=>{
            const next=regionLabels[index];
            return label.region===next.region && Math.abs(label.x-next.x)<0.25 && Math.abs(label.y-next.y)<0.25;
          });
          return same ? prev : regionLabels;
        });
        let rect: { width: number; height: number } | null = null;
        try{ rect = m.getCanvas().getBoundingClientRect(); }catch{}
        const chips: ColonyChip[] = [];
        for(const a of chipAnchors){
          const pr = m.project([a.lng, a.lat]);
          if(rect && offCanvas(pr.x, pr.y, rect)) continue;
          chips.push({ ...a, x:pr.x, y:pr.y, ay:pr.y });
        }
        separateChips(chips);
        /* Second cull, AFTER displacement: separateChips only ever pushes a
           chip down, and at basin zoom a stack of coincident sites can push
           the last one hundreds of pixels past the bottom edge. The layer
           clips it either way — this keeps it out of the DOM instead of
           parking a node nobody can see. */
        const r = rect;
        const live = r ? chips.filter(c=> !offCanvas(c.x, c.y, r)) : chips;
        setOverlayChips(prev=> sameChips(prev, live) ? prev : live);
        const projectedAvoidance=avoidanceRegions.map(region=>{
          const point=m.project([region.lng,region.lat]);
          return {...region,x:point.x,y:point.y};
        });
        setOverlayAvoidanceRegions(prev=>sameAvoidanceRegions(prev,projectedAvoidance) ? prev : projectedAvoidance);
        const movementCards: MovementObservationCard[] = [];
        for(const track of movementTracks){
          const expanded=track.id===selectedMovementId;
          const observations=expanded
            ? track.observations
            : standingFootageIds
              ? track.observations.filter(observation=>standingIdSet.has(observation.surveyId))
              : track.observations.slice(-1);
          const anomalousObservationIds=new Set((track.anomalies ?? []).map(anomaly=>anomaly.observationId));
          for(let localIndex=0;localIndex<observations.length;localIndex++){
            const observation=observations[localIndex];
            const index=track.observations.indexOf(observation);
            const pr=m.project([observation.center.lng,observation.center.lat]);
            movementCards.push({
              x:pr.x,
              y:pr.y,
              lat:observation.center.lat,
              lng:observation.center.lng,
              trackId:track.id,
              id:observation.id,
              index,
              size:observation.size,
              observedAt:observation.observedAt,
              latest:index===track.observations.length-1,
              selected:expanded && observation.id===selectedMovementObservation?.id,
              expanded,
              dimmed:selectedMovementId!==null && !expanded,
              checkpoint:observation.surveyId===checkpointFootageId,
              /* The collapsed current card carries the track-level warning;
                 after expansion the red moves to the exact observation(s)
                 where the deviation was detected. */
              anomalous:expanded
                ? anomalousObservationIds.has(observation.id)
                : anomalousObservationIds.size>0,
            });
          }
        }
        /* Never move a card away from its measured coordinate to resolve an
           overlap. Chronological DOM order makes the most recent observation
           win the stack while every connector remains pinned to real origins. */
        movementCards.sort((a,b)=>{
          const at=Date.parse(a.observedAt), bt=Date.parse(b.observedAt);
          if(Number.isFinite(at) && Number.isFinite(bt) && at!==bt) return at-bt;
          return a.index-b.index;
        });
        setOverlayMovementCards(prev=> sameMovementCards(prev,movementCards) ? prev : movementCards);
        /* The zoom, for the pin readout: a coordinate clicked at basin zoom
           and one clicked at 200 m are not the same claim, and the sortie's
           note records which it was. */
        try{ setZoomNow(m.getZoom()); }catch{}
      } catch { /* map torn down or unprojectable mid-frame — next event retries */ }
    };
    const schedule = ()=>{ if(frame) return; frame = requestAnimationFrame(update); };
    update();
    map.on("move", schedule);
    map.on("zoom", schedule);
    map.on("resize", schedule);
    // `idle` replaces the old 600 ms interval: it fires once after the map
    // settles (tiles in, animation over) instead of ticking forever while
    // nothing moves and nobody is looking.
    map.on("idle", schedule);
    return ()=>{
      if(frame) cancelAnimationFrame(frame);
      try{ map.off("move",schedule); map.off("zoom",schedule); map.off("resize",schedule); map.off("idle",schedule); }catch{}
    };
  },[mapLoaded,trackLines,chipAnchors,movementTracks,selectedMovementId,selectedMovementObservation,avoidanceRegions,standingFootageIds,standingIdSet,checkpointFootageId]);

  /* Chip click = open the site and frame it. The site's own animals decide the
     frame — every placed point of every sortie flown there, so a haul-out
     surveyed three times from three slightly different centres still lands
     whole. Store read at event time; closures over store state go stale
     because the map outlives renders. */
  const handleChipClick = useCallback((chip: SiteChip)=>{
    setSelectedPollutionId(null);
    onSiteClick?.(chip.key);
    const m = mapRef.current; if(!m) return;
    try{ m.stop(); }catch{}
    const s = useFootageStore.getState();
    const ids = new Set(chip.footageIds);
    const pts = s.detections.filter(d=> ids.has(d.footageId) && d.status!=="false_positive");
    const b = colonyBounds(pts);
    if (b) {
      try{ m.fitBounds([[b.minLng, b.minLat],[b.maxLng, b.maxLat]], { padding: 80, duration: 420, maxZoom: 13 }); }catch{}
    } else if (Number.isFinite(chip.lat) && Number.isFinite(chip.lng)) {
      /* No placed animals — the count exists, the points do not. The centroid
         is still a real coordinate, so the camera goes there rather than
         refusing to move and reading as a dead chip. */
      try{ m.easeTo({ center:[chip.lng, chip.lat], zoom: Math.max(m.getZoom(), ZOOM_COLONY+0.4), duration: 420 }); }catch{}
    }
  },[onSiteClick]);

  /* The one camera channel, and its half of the handshake.
   *
   * Anything anywhere — a site card's visit row, an archive row, a report line
   * — dispatches `flyto` on `document`; nothing reaches into this map through a
   * global. The shell listens too, but only to make sure the map is ON SCREEN:
   * when the event is raised from another mode it switches to Карта and
   * re-raises the same detail every 200 ms until somebody answers, because this
   * component may still be code-splitting in when the switch happens.
   *
   * preventDefault() IS the answer. Calling it once the camera has actually
   * moved is what stops the replay; without it the retries simply run out and
   * the camera is eased to the same place up to six times, which is wasteful
   * rather than broken. Replayed events are NOT ignored here — they are the
   * ones this handler exists to receive. */
  useEffect(()=>{
    const h = (e: Event)=>{
      const d = ((e as CustomEvent).detail ?? {}) as Record<string, unknown>;
      const lat = Number(d.lat), lng = Number(d.lng);
      if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const zoom = Number.isFinite(Number(d.zoom)) ? Number(d.zoom) : 8.5;
      const m = mapRef.current; if(!m) return;
      try{ m.stop(); }catch{}
      try{ m.easeTo({ center:[lng,lat], zoom, duration: 260 }); }catch{ return; }
      e.preventDefault();
    };
    document.addEventListener("flyto", h);
    return ()=> document.removeEventListener("flyto", h);
  },[mapLoaded]);

  /* A chip is a clickable DOM overlay, not a child of MapLibre's canvas
     container. That is why clicks work — but it also means a wheel / trackpad
     gesture over the chip bubbles through this React overlay instead of into
     MapLibre, leaving the browser to handle it (a pinch can zoom the whole
     page). Forward an exact native copy to MapLibre's interaction surface and
     cancel the original. Native + passive:false is load-bearing: React's
     wheel listener is passive, so it cannot reliably keep a ctrl+wheel pinch
     away from browser zoom. */
  useEffect(()=>{
    const layer = chipLayerRef.current;
    if(!mapLoaded || !layer) return;
    const forwardWheel = (event: WheelEvent)=>{
      const target = event.target;
      if(!(target instanceof Element) || !target.closest(".colony-chip")) return;
      const map = mapRef.current;
      if(!map) return;
      let interactionSurface: HTMLElement;
      try{ interactionSurface = map.getCanvasContainer(); }catch{ return; }

      event.preventDefault();
      event.stopPropagation();
      interactionSurface.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        button: event.button,
        buttons: event.buttons,
      }));
    };
    layer.addEventListener("wheel", forwardWheel, { passive: false });
    return ()=> layer.removeEventListener("wheel", forwardWheel);
  },[mapLoaded]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-bg">
      <div ref={containerRef} className="absolute inset-0" />
      <div ref={tipRef} className="maptip" style={{ position:"absolute", display:"none", background:"rgba(15,17,21,0.94)", color:"#fff", fontSize:"11px", lineHeight:1.4, padding:"6px 8px", border:"1px solid rgba(255,255,255,0.15)", pointerEvents:"none", zIndex:12, maxWidth:"260px", whiteSpace:"nowrap" }} />

      {/* DOM labels avoid a remote glyph dependency and stay localized even
          when the base map cannot supply Cyrillic/Kazakh font ranges. */}
      <div className="absolute inset-0 z-[4] pointer-events-none" aria-hidden="true">
        {overlayRegionLabels.map(label=>(
          <span
            key={label.region}
            className="absolute uppercase whitespace-nowrap"
            style={{
              left:label.x,
              top:label.y,
              transform:"translate(-50%,-50%)",
              color:"rgba(174,183,194,0.58)",
              fontSize:10,
              letterSpacing:"0.18em",
              textShadow:"0 1px 3px #0b0d10, 0 0 6px #0b0d10",
            }}
          >
            {t(`region.${label.region}`)}
          </span>
        ))}
      </div>

      {/* Flight tracks — thin, neutral, they are context not content */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-[5]" style={{ overflow:"visible" }}>
        {overlayTracks.map(t=>(
          <polyline
            key={t.id}
            points={t.pts.map(p=>`${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={t.id==="pin" ? "var(--accent)" : t.id===selectedId ? "var(--accent)" : "var(--ink)"}
            strokeWidth={t.id===selectedId ? 1.5 : 1}
            strokeOpacity={t.id===selectedId ? 0.9 : 0.28}
            strokeDasharray={t.id===selectedId ? "0" : "5 4"}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>

      {overlayAvoidanceRegions.length>0 && (
        <div className="absolute inset-0 z-[6] pointer-events-none" aria-hidden="true">
          {overlayAvoidanceRegions.map(region=>(
            <div
              key={region.id}
              className={`avoidance-region-label ${selectedMovementId ? "dimmed" : ""}`}
              style={{left:region.x,top:region.y}}
            >
              <span className="avoidance-region-status">{t("avoid.alert")}</span>
              <strong className="tnum">{region.latestCount}</strong>
              <span>{t("avoid.mapNoVisits")}</span>
            </div>
          ))}
        </div>
      )}

      {/* Focused-group links. Straight observation-to-observation connectors,
          not a GPS trail. The latest dated card is intentionally strongest. */}
      {overlayMovementCards.length > 0 && (
        <>
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-[7]" style={{ overflow:"visible" }} aria-hidden="true">
            {overlayMovementCards.filter(point=>point.expanded).slice(1).map((point,index)=>{
              const previous=overlayMovementCards.filter(candidate=>candidate.expanded)[index];
              return (
                <line
                  key={`${previous.id}:${point.id}`}
                  x1={previous.x} y1={previous.y} x2={point.x} y2={point.y}
                  className="movement-card-link"
                />
              );
            })}
          </svg>
          <div className="absolute inset-0 z-[8] pointer-events-none">
            {overlayMovementCards.map(point=>(
              <button
                key={point.id}
                type="button"
                onClick={()=>{
                  const track=movementTracks.find(candidate=>candidate.id===point.trackId);
                  const observation=track?.observations[point.index];
                  onMovementFocus?.();
                  setSelectedPollutionId(null);
                  if(!point.expanded){
                    selectPopulation(point.trackId, point.id);
                    return;
                  }
                  selectPopulationObservation(point.id);
                  if(observation){
                    try { mapRef.current?.easeTo({ center:[observation.center.lng,observation.center.lat], duration:320 }); } catch {}
                  }
                }}
                title={`${new Date(point.observedAt).toLocaleDateString(localeFor(lang))} · ${point.size} ${tp(point.size,"unit.seals")}${point.checkpoint ? ` · ${t("checkpoint.updatedCard")}` : ""}${point.anomalous ? ` · ${t("track.anomalies",{n:1})}` : ""}`}
                aria-expanded={point.expanded}
                data-track-id={point.trackId}
                data-observation-index={point.index}
                data-timestamp-updated={point.checkpoint ? "true" : undefined}
                className={`movement-observation-card ${point.latest ? "latest" : ""} ${point.selected ? "selected" : ""} ${point.expanded ? "expanded" : "collapsed"} ${point.dimmed ? "dimmed" : ""} ${point.anomalous ? "anomaly" : ""} ${point.checkpoint ? "timestamp-updated" : "timestamp-context"}`}
                style={{
                  left:point.x,
                  top:point.y,
                  /* The focused group's chronology owns the stack. Within it,
                     later observations cover earlier ones without moving. */
                  zIndex:point.selected ? 100 : point.expanded ? 10+point.index : undefined,
                }}
              >
                <SealMarkerIcon />
                <span className="movement-card-count tnum">{point.size}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Site markers — the transparent seal/target icon from the product mark
          plus the standing count. Names, ranges and visit history stay in the
          accessible title and site card instead of competing with the map.
          `chipLayerRef` is load-bearing: it prevents a wheel event over the
          marker from zooming the map underneath it. */}
      <div ref={chipLayerRef} className={`chip-layer absolute inset-0 z-[6] pointer-events-none ${pinMode ? "colony-chips-dimmed" : ""}`}>
        {overlayChips.map(c=>{
          const isSel = c.key===selectedSiteKey;
          /* Two ways a chip goes quiet, and they are different claims. A site
             with NO standing count (every visit retired, or none produced a
             number) prints an em dash — the signal colour is for measurements,
             and there is none. A site that counted ZERO keeps its number, in
             ink rather than green: "this beach was empty" is a finding, and a
             green 0 shouts it louder than the 645 next to it. */
          const muted = c.retired || c.count===0;
          const label = c.name ?? `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
          const band = c.low!=null && c.high!=null && c.low!==c.high;
          const displaced = Math.abs(c.y - c.ay) > 8;
          return (
            <span key={c.key} style={{ display: "contents" }}>
            {displaced && (
              /* The stalk: a displaced chip still points at the coordinate it
                 claims, exactly like the prototype. Drawn from the chip's
                 centre to the true anchor; hairline, never interactive. */
              <span
                aria-hidden="true"
                className="chip-stalk"
                style={{
                  position: "absolute",
                  left: c.x,
                  top: Math.min(c.y, c.ay),
                  height: Math.abs(c.y - c.ay),
                  width: 1,
                  background: "var(--ink-4)",
                  pointerEvents: "none",
                }}
              />
            )}
            <button
              onClick={()=>handleChipClick(c)}
              /* The place's name first — a chip reading "Kenderli · 218 seals"
                 is a sentence an ecologist can act on; "218 seals" over a dot
                 is a number they have to go and identify. */
              title={[
                label,
                c.count==null
                  ? t("site.noStanding")
                  : band
                    ? `${c.count} ${tp(c.count, "unit.seals")} (${t("misc.range", { low: c.low as number, high: c.high as number })})`
                    : `${c.count} ${tp(c.count, "unit.seals")}`,
                `${c.visits} ${tp(c.visits, "unit.sorties")}`,
              ].join(" · ")}
              aria-label={t("site.open")}
              className={`colony-chip ${isSel ? "selected z-10" : ""}`}
              style={{ left:c.x, top:c.y, color: muted ? "var(--ink-3)" : undefined }}
            >
              <SealMarkerIcon />
              <span className="chip-best tnum">
                {c.count ?? "—"}
              </span>
            </button>
            </span>
          );
        })}
      </div>

      {/* The environment: weather, water temperature and ice for one moment,
          drawn at the size it was measured. It owns its own GL source and
          inserts its layers UNDER the sortie layers, so switching it on cannot
          cover a count, move a chip or touch the overlay above. */}
      {mapLoaded && <EnvLayer map={mapRef.current} />}

      {/* The map's left-hand stack.
          Everything pinned to this corner lives in ONE column, in flow, because
          three overlays each choosing their own `top-` was three overlays on
          top of each other the moment two layers were on at once: the pollution
          legend and the environment panel both landed under the toggles and the
          legend covered the panel's header and its time field. Flow cannot
          collide with itself. `EnvLayer` portals its panel in here (see
          `data-map-left-stack`) rather than positioning itself, so switching a
          layer on adds a row instead of a collision.
          `items-start` keeps each child its own width; the column never catches
          pointer events itself, only its children do, so the map still drags
          through the gaps. */}
      <div
        data-map-left-stack
        /* The width always leaves the top-right trigger its corner - at EVERY
             width, not just below `sm:`. Reserving it only on mobile is how the
             column and the history button ended up 3420px² on top of each other
             at exactly 640px, where the trigger regains its label (57px -> 183px)
             and the column stopped shrinking to fit. */
          className="pointer-events-none absolute top-3 left-3 z-10 flex max-h-[calc(100%-5rem)] w-[calc(100%-5.75rem)] max-w-[340px] flex-col items-start gap-2 overflow-y-auto overflow-x-hidden sm:max-h-[calc(100%-1.5rem)] sm:w-[calc(100%-13rem)] sm:max-w-[520px]"
      >
      <div className="pointer-events-auto flex flex-wrap items-center gap-2">
        {/* The flat dark plate the map's own controls now wear — one border,
            square, no elevation stack. */}
        <div className="plate flex flex-wrap items-center gap-0.5 p-0.5">
          <Toggle checked={satellite} onChange={setSatellite} label={t("map.satellite")} />
          <span className="w-px h-4 bg-line mx-0.5" />
          <Toggle checked={layerState.footprints} onChange={v=>setLayer("footprints",v)} label={t("map.tracks")} />
          <Toggle checked={layerState.detections} onChange={v=>setLayer("detections",v)} label={t("map.colonies")} />
          <span className="w-px h-4 bg-line mx-0.5" />
          <Toggle
            checked={showPollution}
            onChange={value=>{
              setShowPollution(value);
              if(!value) setSelectedPollutionId(null);
            }}
            label={t("map.pollution")}
          />
          <Toggle checked={envOn} onChange={setEnvOn} label={t("env.title")} />
        </div>
        {pinMode && (
          <PinReadout
            value={pinPoints.length ? { lat: pinPoints[0].lat, lng: pinPoints[0].lng } : null}
            zoom={zoomNow}
            entry={pinEntry}
            onChange={(p)=>{
              setPinPoints([{ t: 0, lat: p.lat, lng: p.lng }]);
              try { useIngestStore.getState().notePin("typed", zoomNow); } catch {}
              const m = mapRef.current;
              if(m){ try{ m.easeTo({ center:[p.lng, p.lat], duration: 250 }); }catch{} }
            }}
            /* Only when a file is actually waiting for this point. An anchor
               with no owner has nothing to confirm INTO, so the card offers no
               Confirm and does not promise one — Загрузка says what to do with
               it (ingest.anchorNoOwner). */
            onConfirm={pinTarget ? () => {
              /* The same store action the queue row's Confirm runs, and then
                 the trip back: the point was placed here, the file it belongs
                 to is over there, and leaving somebody on the map wondering
                 whether it took was the whole complaint. */
              if (useIngestStore.getState().applyPin()) setMode("ingest");
            } : undefined}
            /* Escape and a visible Отмена: the crosshair can always be put
               down, whether or not a file is waiting for it. */
            onCancel={() => {
              try { useIngestStore.getState().claimPin(null); } catch {}
              setPinPoints([]);
              useFootageStore.getState().setPinMode(false);
            }}
          />
        )}
      </div>
      {pollutionError && showPollution && !pinMode && (
        <div className="plate pointer-events-auto w-full border border-bad px-2.5 py-1.5 text-2xs text-bad">
          {t("pollution.loadError")}
        </div>
      )}
      {!pollutionError && showPollution && !pinMode && !selectedPollution && (
        <div data-pollution-legend className="plate pointer-events-auto w-full border border-line px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink3">
            <span className="tnum text-ink2">{pollutionDisplayData.features.length} · {t("map.pollution")}</span>
            {[
              ["#f04e45",t("pollution.ageDay")],
              ["#e96b3c",t("pollution.ageWeek")],
              ["#dc8733",t("pollution.ageMonth")],
              ["#b49a56",t("pollution.ageQuarter")],
              ["#718094",t("pollution.ageOlder")],
            ].map(([color,label])=>(
              <span key={label} className="inline-flex items-center gap-1 whitespace-nowrap">
                <span className="h-1.5 w-1.5" style={{background:color}} />
                {label}
              </span>
            ))}
          </div>
          {pollutionHealth && (pollutionHealth.failed > 0 || pollutionHealth.stale > 0) && (
            <div className="mt-1.5 border-t border-line pt-1.5 text-2xs text-warn">
              {pollutionHealth.failed} {t("pollution.sourcesFailed")}
              <span className="mx-1.5 text-ink3">·</span>
              {pollutionHealth.stale} {t("pollution.sourcesStale")}
            </div>
          )}
        </div>
      )}
      {/* EnvLayer's panel arrives here by portal, as the last row. */}
      </div>

      {selectedPollution && showPollution && !pinMode && (
        <PollutionEvidenceCard
          feature={selectedPollution}
          referenceAt={pollutionReferenceTime}
          locale={localeFor(lang)}
          onClose={()=>setSelectedPollutionId(null)}
        />
      )}

      {selectedMovementTrack && selectedMovementObservation && !pinMode && (
        <MovementTrackCard
          track={selectedMovementTrack}
          observation={selectedMovementObservation}
          footage={selectedMovementFootage}
          locale={localeFor(lang)}
          title={selectedPopulationName ?? `${t("track.group")} ${selectedMovementTrack.ordinal}`}
          sightingsLabel={t("track.sightings")}
          sizeLabel={t("track.size")}
          lastSeenLabel={t("track.lastSeen")}
          onObservation={(observation)=>{
            selectPopulationObservation(observation.id);
            const map=mapRef.current;
            if(map){
              try { map.easeTo({ center:[observation.center.lng,observation.center.lat], duration:320 }); } catch {}
            }
          }}
          onClose={()=>selectPopulation(null)}
        />
      )}

      {!mapLoaded && (
        <div className="absolute inset-0 grid place-items-center bg-bg z-20">
          <span className="text-sm text-ink3">{t("map.loading")}</span>
        </div>
      )}
    </div>
  );
}

function PollutionEvidenceCard({
  feature,
  referenceAt,
  locale,
  onClose,
}: {
  feature: PollutionFeature;
  referenceAt?: string | null;
  locale: string;
  onClose: ()=>void;
}) {
  const { t } = useT();
  const p = feature.properties;
  const date = p.observed_at ? new Date(p.observed_at) : null;
  const reported = date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(locale,{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})
    : t("pollution.ageUnknown");
  const age = pollutionAgeBucket(p.observed_at,referenceAt);
  const ageLabel = {
    day:t("pollution.ageDay"),
    week:t("pollution.ageWeek"),
    month:t("pollution.ageMonth"),
    quarter:t("pollution.ageQuarter"),
    older:t("pollution.ageOlder"),
    unknown:t("pollution.ageUnknown"),
  }[age];
  const kind = {
    flare:t("pollution.kindFlare"),
    slick:t("pollution.kindSlick"),
    spill:t("pollution.kindSpill"),
    discharge:t("pollution.kindDischarge"),
  }[p.kind] ?? t("pollution.kindOther");
  const confidence = typeof p.confidence === "number" && Number.isFinite(p.confidence)
    ? `${Math.round((p.confidence <= 1 ? p.confidence * 100 : p.confidence))}%`
    : null;
  const sourceLink = p.source_link ?? p.source_url ?? null;

  const evidenceTitle = (p.title ?? "")
    .replace(/^(?:data-[\w-]+\s*=\s*"[^"]*"\s*)+>\s*/i,"")
    .trim();

  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown",key);
    return ()=>window.removeEventListener("keydown",key);
  },[onClose]);

  return (
    <aside data-pollution-card={p.id} className="absolute inset-x-0 bottom-0 top-0 z-20 flex w-full flex-col border-line bg-bg sm:inset-x-auto sm:right-0 sm:w-[360px] sm:max-w-[86%] sm:border-l">
      <header className="shrink-0 flex items-start justify-between gap-3 border-b border-line bg-bg px-4 pt-3.5 pb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-ink">{t("pollution.title")}</h2>
          <p className="mt-1 text-2xs text-ink3">{kind} · {ageLabel}</p>
        </div>
        <button onClick={onClose} aria-label={t("btn.close")} className="grid h-6 w-6 place-items-center text-sm text-ink3 hover:bg-surface2 hover:text-ink" title={t("btn.close")}>×</button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="px-4 py-4">
          <span className="hd">{t("pollution.rootCause")}</span>
          <p className="mt-2 text-base font-semibold leading-snug text-ink">
            {p.root_cause || t("pollution.causeUnknown")}
          </p>
          {evidenceTitle && (
            <p className="mt-3 border-l border-hair pl-2.5 text-xs leading-relaxed text-ink2">{evidenceTitle}</p>
          )}
        </section>

        <dl className="border-t border-hair px-4 py-3 text-xs">
          <PollutionFact label={t("pollution.reported")} value={reported} />
          <PollutionFact label={t("pollution.source")} value={p.source_name || p.source_id} />
          <PollutionFact label={t("row.location")} value={`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`} mono />
          <PollutionFact label={t("pollution.precision")} value={p.location_precision || "—"} />
          <PollutionFact label={t("pollution.uncertainty")} value={`${Math.round(p.radius_m || 0).toLocaleString(locale)} m`} mono />
          {confidence && <PollutionFact label={t("pollution.confidence")} value={confidence} mono />}
        </dl>

        <section className="border-t border-hair px-4 py-4">
          <p className="text-2xs leading-relaxed text-ink3">{t("pollution.uncertaintyMeaning")}</p>
          {sourceLink && (
            <a href={sourceLink} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-accent hover:underline">
              {t("pollution.openSource")}
            </a>
          )}
        </section>
      </div>
    </aside>
  );
}

function PollutionFact({label,value,mono=false}:{label:string;value:string;mono?:boolean}){
  return (
    <div className="grid grid-cols-[128px_1fr] gap-3 border-b border-hair py-2 last:border-0">
      <dt className="text-ink3">{label}</dt>
      <dd className={`min-w-0 break-words text-ink2 ${mono ? "tnum" : ""}`}>{value}</dd>
    </div>
  );
}

function MovementTrackCard({
  track,
  observation,
  footage,
  locale,
  title,
  sightingsLabel,
  sizeLabel,
  lastSeenLabel,
  onObservation,
  onClose,
}: {
  track: GroupTrack;
  observation: GroupObservation;
  footage: Footage | null;
  locale: string;
  title: string;
  sightingsLabel: string;
  sizeLabel: string;
  lastSeenLabel: string;
  onObservation: (observation: GroupObservation)=>void;
  onClose: ()=>void;
}) {
  const {t,tp}=useT();
  const dateOf=(value:string)=>{
    const d=new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(locale,{ day:"2-digit",month:"short",year:"numeric" });
  };
  const anomalies=track.anomalies ?? [];
  const observationAnomalies=anomalies.filter(anomaly=>anomaly.observationId===observation.id);
  const anomalyName=(kind:(typeof anomalies)[number]["kind"])=>{
    switch(kind){
      case "speed": return t("track.anomalySpeed");
      case "sharp_turn": return t("track.anomalySharpTurn");
      case "unusual_interval": return t("track.anomalyInterval");
      case "route_deviation": return t("track.anomalyRoute");
    }
  };
  const hasFrame=!!footage && !footage.videoUrl && !!footage.mediaId && (footage.pixels?.length ?? 0)>0;
  const reversed=[...track.observations].map((item,index)=>({item,index})).reverse();
  return (
    <aside data-population-track-card={track.id} className="absolute inset-x-0 bottom-0 top-0 z-20 flex w-full flex-col border-line bg-bg sm:inset-x-auto sm:right-0 sm:w-[360px] sm:max-w-[86%] sm:border-l">
      <header className="shrink-0 flex items-start justify-between gap-3 border-b border-line bg-bg px-4 pt-3.5 pb-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
          <p className="mt-1 text-2xs text-ink3">
            {sightingsLabel}: {track.observations.length} · {t("track.inferred")}
          </p>
        </div>
        <button onClick={onClose} aria-label={`${title} ×`} className="grid h-6 w-6 place-items-center text-sm text-ink3 hover:bg-surface2 hover:text-ink" title="×">×</button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* This is the GROUP snapshot's count, never the containing sortie's
            total. A 74-card must open 74 even if its drone flight saw 415
            animals across several unrelated groups. */}
        <div className="px-4 py-4">
          <div className="flex items-end gap-3">
            <span className="tnum text-accent" style={{fontSize:42,lineHeight:0.88,fontWeight:500,letterSpacing:"-0.038em"}}>
              {observation.size}
            </span>
            <span className="text-2xs text-ink3 leading-snug pb-1">
              {tp(observation.size,"unit.seals")}<br />{sizeLabel}
            </span>
          </div>
          <p className="mt-2.5 text-2xs text-ink3 tnum">
            {dateOf(observation.observedAt)} · {observation.center.lat.toFixed(4)}, {observation.center.lng.toFixed(4)}
          </p>
          {observationAnomalies.length>0 && (
            <div className="mt-3 border-l border-bad pl-2 text-xs text-bad">
              {observationAnomalies.map(anomaly=><div key={anomaly.id}>{anomalyName(anomaly.kind)}</div>)}
            </div>
          )}
        </div>

        {hasFrame && footage?.mediaId && (
          <div className="px-4 pb-4">
            <div className="aspect-video bg-bg border border-hair overflow-hidden">
              <EvidenceFrame mediaId={footage.mediaId} pixels={footage.pixels ?? []} />
            </div>
            <p className="mt-1.5 text-2xs text-ink3 truncate">{footage.filename}</p>
          </div>
        )}

        {!hasFrame && footage && (
          <div className="px-4 pb-4 text-2xs text-ink3">
            <p className="truncate">{footage.filename}</p>
            {(footage.videoUrl || /\.mp4$/i.test(footage.filename)) && <p className="mt-1 text-ink4">{t("rev.noFrame")}</p>}
          </div>
        )}

        <div className="px-4 py-4 border-t border-hair">
          <span className="hd">{t("site.dynamics")}</span>
          <MovementSizeDynamics track={track} selectedId={observation.id} locale={locale} />
        </div>

        <div className="px-4 py-4 border-t border-hair">
          <div className="flex items-baseline justify-between gap-3">
            <span className="hd">{sightingsLabel}</span>
            <span className="text-2xs text-ink4">{lastSeenLabel}: {dateOf(track.observations[track.observations.length-1].observedAt)}</span>
          </div>
          <ol className="mt-2.5" aria-label={sightingsLabel}>
          {reversed.map(({item,index})=>{
            const selected=item.id===observation.id;
            const itemAnomalies=anomalies.filter(anomaly=>anomaly.observationId===item.id);
            return (
              <li key={item.id} className="border-b border-hair last:border-0">
                <button
                  data-observation-id={item.id}
                  onClick={()=>onObservation(item)}
                  className={`grid w-full grid-cols-[22px_1fr_auto] items-center gap-2 px-1 py-2 text-left transition-colors ${selected ? "bg-surface2" : "hover:bg-surface2"}`}
                >
                  <span className={`grid h-5 w-5 place-items-center border text-2xs tnum ${selected ? "border-accent bg-accent text-bg" : itemAnomalies.length ? "border-bad text-bad" : "border-ink4 text-ink3"}`}>{index+1}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink2">{dateOf(item.observedAt)}</span>
                    <span className="block truncate text-2xs text-ink4 tnum">{item.center.lat.toFixed(3)}, {item.center.lng.toFixed(3)}</span>
                    {itemAnomalies.map(anomaly=><span key={anomaly.id} className="block text-2xs text-bad">{anomalyName(anomaly.kind)}</span>)}
                  </span>
                  <span className={`text-base font-medium tnum ${itemAnomalies.length ? "text-bad" : "text-ink"}`}>{item.size}</span>
                </button>
              </li>
            );
          })}
          </ol>
        </div>

        {footage?.notes && (
          <div className="px-4 py-4 border-t border-hair">
            <span className="hd">{t("rec.notes.title")}</span>
            <p className="mt-2 border-l border-hair pl-2.5 text-xs text-ink2 leading-relaxed">{footage.notes}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function MovementSizeDynamics({track,selectedId,locale}:{track:GroupTrack;selectedId:string;locale:string}){
  const observations=track.observations;
  const width=320,height=82,pad={l:8,r:8,t:10,b:16};
  const values=observations.map(item=>item.size);
  const min=Math.min(...values),max=Math.max(...values);
  const range=max-min || 1;
  const x=(index:number)=>observations.length===1 ? width/2 : pad.l+(index/(observations.length-1))*(width-pad.l-pad.r);
  const y=(value:number)=>pad.t+(1-(value-min)/range)*(height-pad.t-pad.b);
  const date=(value:string)=>{
    const d=new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(locale,{day:"2-digit",month:"short"});
  };
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between text-2xs text-ink4 tnum"><span>min {min}</span><span>max {max}</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 block w-full" role="img">
        <line x1={pad.l} y1={height-pad.b} x2={width-pad.r} y2={height-pad.b} stroke="var(--hair)" />
        {observations.map((item,index)=>{
          const selected=item.id===selectedId;
          const anomalous=(track.anomalies ?? []).some(anomaly=>anomaly.observationId===item.id);
          return <circle key={item.id} cx={x(index)} cy={y(item.size)} r={selected?4:3} fill={anomalous?"var(--bad)":selected?"var(--accent)":"var(--ink-3)"} />;
        })}
        <text x={pad.l} y={height-2} fill="var(--ink-4)" fontSize="9">{date(observations[0].observedAt)}</text>
        <text x={width-pad.r} y={height-2} textAnchor="end" fill="var(--ink-4)" fontSize="9">{date(observations[observations.length-1].observedAt)}</text>
      </svg>
    </div>
  );
}

// The overlay re-projects on every map move and on a timer; bail out of the
// state update when the projection is identical so React can stay idle.
function sameChips(a: ColonyChip[], b: ColonyChip[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    const x=a[i], y=b[i];
    if(x.key!==y.key || x.count!==y.count || x.low!==y.low || x.high!==y.high) return false;
    if(x.name!==y.name || x.retired!==y.retired || x.visits!==y.visits) return false;
    /* The spark is redrawn from these values, so a visit whose count changed
       under review has to reach the DOM even when the site's standing figure
       did not move. Length first, then the values — the array is one number
       per visit, so this is a handful of comparisons per chip. */
    if(x.spark.length!==y.spark.length) return false;
    for(let k=0;k<x.spark.length;k++) if(x.spark[k]!==y.spark[k]) return false;
    if(Math.abs(x.x-y.x)>0.5 || Math.abs(x.y-y.y)>0.5 || Math.abs(x.ay-y.ay)>0.5) return false;
  }
  return true;
}
function sameTracks(a:any[], b:any[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    const x=a[i], y=b[i];
    if(x.id!==y.id || x.pts.length!==y.pts.length) return false;
    /* Sample first, middle and last. Comparing only the FIRST vertex meant a
       polyline that had genuinely moved — a rotation or a pan pivoting near
       its start point — compared equal and was never repainted. */
    const n=x.pts.length;
    for(const k of [0, n>>1, n-1]){
      if(Math.abs(x.pts[k].x-y.pts[k].x)>0.5 || Math.abs(x.pts[k].y-y.pts[k].y)>0.5) return false;
    }
  }
  return true;
}

function sameMovementCards(a:MovementObservationCard[],b:MovementObservationCard[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    const x=a[i],y=b[i];
    if(x.trackId!==y.trackId || x.id!==y.id || x.index!==y.index || x.size!==y.size || x.latest!==y.latest || x.selected!==y.selected || x.expanded!==y.expanded || x.dimmed!==y.dimmed || x.anomalous!==y.anomalous || x.checkpoint!==y.checkpoint) return false;
    if(Math.abs(x.x-y.x)>0.5 || Math.abs(x.y-y.y)>0.5) return false;
  }
  return true;
}

function sameAvoidanceRegions(a:ProjectedAvoidanceRegion[],b:ProjectedAvoidanceRegion[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    const x=a[i],y=b[i];
    if(x.id!==y.id || x.latestCount!==y.latestCount || x.region!==y.region) return false;
    if(Math.abs(x.x-y.x)>0.5 || Math.abs(x.y-y.y)>0.5) return false;
  }
  return true;
}

/**
 * PinReadout — where the pin is, in words, while it is being placed.
 *
 * Two ways in, one control: click the map, or type the coordinate. Pinning
 * used to be a badge that said "anchor set" and nothing else, so the operator
 * confirmed a coordinate they had never seen — and a field team arriving with
 * a GPS reading had no way at all to enter it.
 *
 * Self-contained on purpose (value in, coordinate out, no store): the manual
 * ground-count entry needs exactly this control for exactly the same reason,
 * and a second copy of it would drift.
 */
export function PinReadout({
  value,
  zoom,
  entry,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: { lat: number; lng: number } | null;
  zoom: number | null;
  /** How the current value arrived. A map click is rounded to three decimals
   *  on the way into the store; a typed coordinate is kept exactly as typed.
   *  The readout has to say which, because the two have different precision
   *  and the label used to claim the click's for both. */
  entry?: "click" | "typed" | null;
  onChange: (p: { lat: number; lng: number }) => void;
  /** Accept the point and hand it to whatever is waiting for it. Absent when
   *  nothing is: then this card only reports and sets a coordinate, and it
   *  promises no Confirm it does not have. */
  onConfirm?: () => void;
  /** Leave pin mode without placing anything. A mode that changes the cursor,
   *  dims the chips and reinterprets every click is modal, and a modal state
   *  with no way out but a correct answer is a trap: the crosshair outlived the
   *  screen it was armed from and there was nothing on the map to dismiss it
   *  with. Escape does it too — bound below. */
  onCancel?: () => void;
}) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const typed = entry === "typed";

  const apply = () => {
    const raw = text.trim();
    /* An empty box over a point that is already on the map is not a mistake:
       the operator clicked the map and then pressed the only button on the
       card. Answering that with the red parse error read as "your click was
       refused, type it instead" — so it accepts the click instead. */
    if (!raw && value && onConfirm) {
      setBad(false);
      onConfirm();
      return;
    }
    /* One shared parser, and a pure one. Inline here it rejected the most
       common paste in the world — "43.65,51.18", straight out of Google Maps —
       because it normalised decimal commas before it split on the separator.
       lib/parsers/latlng.ts has that case in its selftest now. */
    const p = parseLatLng(raw);
    if (!p) {
      setBad(true);
      return;
    }
    setBad(false);
    setText("");
    onChange(p);
    /* Typed, set, done — the same one gesture the Confirm button is. Without
       this the coordinate landed and the operator was left on the map with no
       sign that anything had been accepted. */
    onConfirm?.();
  };

  return (
    <div className="plate px-2.5 py-2 max-w-[260px]">
      <div className="text-2xs text-ink3">
        {value ? (onConfirm ? t("map.anchorSet") : t("map.anchorSetOrphan")) : t("map.clickCentre")}
      </div>
      {value && (
        /* The coordinate is the readout's figure, so it is set like one:
           Inter at reading size with tabular, slashed-zero digits. It used to
           be typewriter text at 11 px — a monospace face on a number the eye
           reads as a pair of quantities, not as a string to diff. */
        <div className="text-lead text-ink tnum mt-1">
          {/* Shown at the precision it is STORED at. A click is rounded to
              three decimals before it reaches the store, so printing three is
              the whole value; a typed coordinate is kept verbatim, and
              trimming it here displayed 43.651 for a 43.6512345 that then went
              into the GeoJSON, the CSV and the report at full length. */}
          {typed
            ? `${value.lat}, ${value.lng}`
            : `${value.lat.toFixed(3)}, ${value.lng.toFixed(3)}`}
        </div>
      )}
      {/* The precision claim, out loud, and only the one that is true of this
          value. A map click is three decimals — about 110 m — and the zoom says
          how much of that the gesture could actually see. A typed coordinate is
          as precise as it was typed, and describing it as 3-decimal was the
          label contradicting the data underneath it. */}
      <div className="text-2xs text-ink3 mt-0.5 leading-tight tnum">
        {typed
          ? t("map.pinPrecisionTyped")
          : zoom != null
            ? t("map.pinPrecisionZoom", { z: zoom.toFixed(1) })
            : t("map.pinPrecision")}
      </div>
      <div className="flex items-baseline gap-2 mt-1.5">
        {/* An underline, not a box: a value written onto the instrument. */}
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }}
          placeholder={t("map.coordPlaceholder")}
          aria-label={t("map.coordEnter")}
          className={`w-[132px] h-6 bg-transparent border-x-0 border-t-0 border-b px-0 text-xs text-ink tnum transition-colors focus:outline-none ${bad ? "border-bad" : "border-line focus:border-ink2"}`}
        />
        <button
          onClick={apply}
          className="h-6 px-2 border border-line text-2xs text-ink2 hover:bg-hover hover:text-ink hover:border-ink4 transition-colors"
        >
          {t("map.coordApply")}
        </button>
      </div>
      {bad && <div className="text-2xs text-bad mt-0.5">{t("map.coordBad")}</div>}
      {/* The promise the card has been making, kept: the point is accepted
          HERE, where it was placed, and the file that asked for it is taken
          back up on its own screen. */}
      {(onConfirm || onCancel) && (
        <div className="mt-2 flex items-center gap-1.5">
          {onConfirm && (
            <Button variant="primary" full disabled={!value} onClick={apply}>
              {t("btn.confirm")}
            </Button>
          )}
          {/* The other half of a modal state. Escape does the same thing; this
              is the version you can see, which is the version a person who has
              never used the app will find. */}
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              {t("btn.cancel")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked:boolean; onChange:(v:boolean)=>void; label:string }){
  return (
    <button
      onClick={()=>onChange(!checked)}
      aria-pressed={checked}
      /* 24px high is a mouse target. A finger needs about 44, so on a phone the
         row grows and the desktop size returns at `sm:`. */
      className={`h-9 px-3 text-xs transition-colors sm:h-6 sm:px-2 sm:text-2xs ${
        checked ? "bg-hover text-ink" : "text-ink3 hover:text-ink2"
      }`}
    >
      {label}
    </button>
  );
}
