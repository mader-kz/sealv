"use client";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { useIngestStore } from "@/store/useIngestStore";
import { colonyHull, expandHull, colonyBounds } from "@/lib/colony";
import { countOf } from "@/lib/analytics/count";
import { footagesInRange, detectionsFor } from "@/lib/analytics/brush";
import type { Detection } from "@/lib/types";
import { useT } from "@/lib/i18n";

// Caspian bounds
const CASPIAN_BOUNDS: [[number, number],[number,number]] = [[46,36],[55,48]];
const AKTAU: [number, number] = [51.18, 43.65];

/* The three reading distances of the chart. Far: one chip per sortie — a
   count with its honesty band, nothing else. Mid: the chip grows a colony
   outline under it. Close: the outline fills with the individual animals.
   The chip never leaves — it is the sortie's handle at every zoom. */
const ZOOM_COLONY = 8.2;   // hull outlines appear
const ZOOM_ANIMALS = 11.5; // per-animal dots appear

const EMPTY_FC = { type: "FeatureCollection", features: [] as any[] };

/** A hand-placed coordinate, at the precision a click supports (~110 m). */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const DARK_STYLE: any = {
  version: 8,
  // Use Carto Dark + Esri Satellite as raster overlay trick? For MVP use simple dark with coastline emphasis
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png","https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"],
      tileSize: 256,
      attribution: "© Carto © OpenStreetMap",
    },
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: "Esri",
    }
  },
  layers: [
    // GL cannot read CSS vars — #13161b is --bg baked in, so map void = app bg.
    { id: "bg", type: "background", paint: { "background-color": "#13161b" } },
    // Dial the basemap right down — it is context, and the counts drawn on top
    // are the only things that should carry contrast. brightness-min lifts the
    // tile blacks off the floor so water/land separate from the app background
    // instead of pooling into one tar pit with it.
    { id: "osm", type: "raster", source: "osm", paint: {
      "raster-opacity": 1,
      "raster-brightness-min": 0.06,
      "raster-brightness-max": 0.72,
      "raster-saturation": -0.45,
      "raster-contrast": 0.05,
    } },
  ],
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
};

/* One DOM chip per sortie: the count, and under it the low–high band when the
   engine produced one. Projected via map.project like the track overlay —
   DOM renders under any GL backend (headless/software included), which is why
   the chip is NOT a symbol layer. */
type ColonyChip = {
  x: number; y: number;
  fid: string;
  count: number;
  low: number | null;
  high: number | null;
  /* The site this sortie belongs to, once someone has named it. Unnamed sites
     keep their coordinates and this stays null — a placeholder name would be
     a fact about the map, not about the coast. */
  name: string | null;
};

/* Where a chip wants to sit, in world coordinates. Computed from the data
   once; the move handler only projects it. */
type ChipAnchor = {
  fid: string;
  lng: number; lat: number;
  count: number;
  low: number | null;
  high: number | null;
  name: string | null;
};

/** The site name a sortie carries, read defensively: the field is written by
 *  the site registry and an archive row loaded before any site was named
 *  simply does not have it. */
const siteNameOf = (f: unknown): string | null => {
  const n = (f as { siteName?: unknown } | null)?.siteName;
  return typeof n === "string" && n.trim() ? n.trim() : null;
};

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

export default function CaspianMap({ onMapReady }: { onMapReady?: (m: any)=>void }) {
  const { t, tp } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [satellite, setSatellite] = useState(false);
  /* The live zoom, kept for the pin readout. Updated in the same rAF pass the
     chip overlay already runs, so it costs nothing extra. */
  const [zoomNow, setZoomNow] = useState<number | null>(null);
  const footagesRaw = useFootageStore(s=>s.footages);
  const detectionsRaw = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);
  const hydrating = useFootageStore(s=>s.hydrating);
  // Filter by the timeline brush. These MUST be memoised — the overlay effect
  // depends on them, so rebuilding the arrays every render made the effect
  // re-run, setState, and re-render forever.
  // This was the fifth private copy of the brush arithmetic, and it differed
  // from the shared one: on a sortie whose date will not parse it compared
  // NaN, so the map dropped a survey that the panel, the dashboard and the
  // report all still counted. footagesInRange keeps it — a malformed
  // timestamp is a reason to show a survey suspiciously, not to hide it.
  // The functions are pure (no React, no zustand), so importing them here
  // does not disturb this file's once-per-mount discipline.
  const footages = useMemo(()=> footagesInRange(footagesRaw, timeRange), [footagesRaw, timeRange]);
  const detections = useMemo(()=> detectionsFor(footages, detectionsRaw), [footages, detectionsRaw]);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const layerState = useFootageStore(s=>s.layerState);
  const setLayer = useFootageStore(s=>s.setLayer);
  const pinMode = useFootageStore(s=>s.pinMode);
  const pinPoints = useFootageStore(s=>s.pinPoints);
  const setPinPoints = useFootageStore(s=>s.setPinPoints);
  /* Depend on the two booleans, not on the layerState object: setLayer hands
     back a fresh object every toggle, so an effect keyed on the object re-ran
     for a flag it does not read. */
  const showTracks = layerState.footprints;
  const showColonies = layerState.detections;

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
      attributionControl: false,
      dragPan: true,
      scrollZoom: true,
      dragRotate: false,
      touchZoomRotate: true,
      cooperativeGestures: false,
    });
    if (NavCtrl) map.addControl(new NavCtrl({ showCompass: false }), "bottom-right");
    if (AttrCtrl) map.addControl(new AttrCtrl({ compact: true }), "bottom-left");
    // ensure interactions enabled — overlay was blocking
    try{ map.dragPan.enable(); map.scrollZoom.enable(); map.doubleClickZoom.enable(); map.boxZoom.enable(); map.keyboard.enable(); }catch{}
    map.on("load", ()=> {
      map.addSource("footprints", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      // Colonies as areas, animals as bare points. No per-dot count labels
      // anywhere — a dot is one animal, and drawing "1" on each was noise
      // left over from the mock era.
      map.addSource("colonies", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("animals", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addLayer({ id: "footprints-line", type:"line", source:"footprints", paint:{ "line-color":"#ffffff", "line-width":1, "line-opacity":0.3 } });
      map.addLayer({ id:"footprints-fill", type:"fill", source:"footprints", paint:{ "fill-color":"#ffffff", "fill-opacity":0.04 } });
      // Colony outline: the haul-out drawn as an area, not a soup of dots.
      // Appears from mid zoom; far out the chip alone carries the story.
      map.addLayer({ id:"colony-fill", type:"fill", source:"colonies", minzoom: ZOOM_COLONY, paint:{
        "fill-color":"#e0a13c",
        "fill-opacity":0.16, // lifted raster floor eats a little of the tint — keep in sync with the pin toggle below
      }});
      map.addLayer({ id:"colony-line", type:"line", source:"colonies", minzoom: ZOOM_COLONY, paint:{
        "line-color":"#e0a13c",
        "line-width": ["case",["==",["get","selected"],true], 2, 1.5],
        "line-opacity": ["case",["==",["get","selected"],true], 1, 0.8],
      }});
      // Individual animals only at close zoom, bare dots, no labels.
      // GL cannot read CSS vars, so var(--good) is baked in as #74b294.
      map.addLayer({ id:"animal-dots", type:"circle", source:"animals", minzoom: ZOOM_ANIMALS, paint:{
        "circle-radius": 3.5,
        "circle-color": ["case",["==",["get","status"],"validated"],"#74b294","#ffffff"],
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

  // update cursor when pinMode toggles; in pin mode the data layers step
  // back so the one thing being placed is the loudest thing on the chart
  useEffect(()=>{
    const m = mapRef.current; if (!m) return;
    m.getCanvas().style.cursor = pinMode ? "crosshair" : "";
    for (const [id, prop, on, off] of [
      ["colony-fill","fill-opacity",0.16,0.04],
      ["colony-line","line-opacity",0.8,0.25],
      ["animal-dots","circle-opacity",1,0.25],
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
        map.addLayer({ id:"esri-raster", type:"raster", source:"esri", paint:{ "raster-opacity":0.95, "raster-brightness-max":0.6, "raster-saturation":-0.35 } }, "footprints-fill");
      } else map.setLayoutProperty("esri-raster","visibility","visible");
      try{ map.setPaintProperty("footprints-line","line-color","#facc15"); }catch{}
    } else {
      if (map.getLayer("osm")) map.setLayoutProperty("osm","visibility","visible");
      if (map.getLayer("esri-raster")) map.setLayoutProperty("esri-raster","visibility","none");
      if (mapLoaded) try{ map.setPaintProperty("footprints-line","line-color","#22d3ee"); }catch{}
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
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    /* Not while the archive is still arriving. Hydration commits each sortie
       to the store the moment its points resolve, so during boot fitKey takes
       a new value per merged run — five self-cancelling 520 ms fitBounds
       animations on today's fixture, and one per sortie at the design target
       of hundreds per season. hydrating is in the deps, so the camera settles
       exactly once, on the finished set, the moment it flips false. */
    if (hydrating) return;
    if (fitKey && !selectedId) {
      // compute bounds of all tracks + detections
      let minLng=180, minLat=90, maxLng=-180, maxLat=-90;
      for(const f of footages){ for(const p of f.track){ minLng=Math.min(minLng,p.lng); maxLng=Math.max(maxLng,p.lng); minLat=Math.min(minLat,p.lat); maxLat=Math.max(maxLat,p.lat); } }
      for(const d of detections){ minLng=Math.min(minLng,d.lng); maxLng=Math.max(maxLng,d.lng); minLat=Math.min(minLat,d.lat); maxLat=Math.max(maxLat,d.lat); }
      if (isFinite(minLng)) {
        const pad = 0.15;
        try { map.stop(); map.fitBounds([[minLng-pad, minLat-pad],[maxLng+pad, maxLat+pad]], { padding: 40, duration: 520, maxZoom: ZOOM_COLONY }); } catch{}
      }
    }
    /* `footages` and `detections` are read latest ON PURPOSE and kept out of
       the deps: the camera must move when the SET of sorties changes (that is
       fitKey), never because a verdict click handed us a new `detections`
       array identity — that would yank the map out from under the review. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[fitKey, mapLoaded, selectedId, hydrating]);

  /* DOM overlay — tracks and colony chips, guaranteed visible even if GL
     layers/glyphs fail. Everything that depends only on the DATA is computed
     here, once; the move handler below is left with nothing but projection. */
  const [overlayChips, setOverlayChips] = useState<ColonyChip[]>([]);
  const [overlayTracks, setOverlayTracks] = useState<Array<{pts:Array<{x:number,y:number}>, id:string}>>([]);

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

  /* One chip per sortie, anchored at the centre of the colony's bounding box
     (fallback: the sortie centre). The number comes from countOf() — the one
     shared definition: the engine's best estimate, else the surviving
     detections plus the animals it counted but could not place. The point
     cloud supplies the GEOMETRY only, so the chip over a colony and the
     inspector's headline for that same sortie can never disagree. */
  const chipAnchors = useMemo(()=>{
    if(!showColonies) return [] as ChipAnchor[];
    const out: ChipAnchor[] = [];
    for(const f of footages){
      const pts = placed.byFootage.get(f.id);
      const b = pts ? colonyBounds(pts) : null;
      const lat = b ? (b.minLat+b.maxLat)/2 : f.center?.lat;
      const lng = b ? (b.minLng+b.maxLng)/2 : f.center?.lng;
      if(!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const hasBand = f.band != null && f.band.low != null && f.band.high != null && f.band.low !== f.band.high;
      out.push({
        fid: f.id,
        lng: lng as number, lat: lat as number,
        count: countOf(f),
        low: hasBand ? f.band!.low : null,
        high: hasBand ? f.band!.high : null,
        name: siteNameOf(f),
      });
    }
    return out;
  },[footages, placed, showColonies]);

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
        let rect: { width: number; height: number } | null = null;
        try{ rect = m.getCanvas().getBoundingClientRect(); }catch{}
        const chips: ColonyChip[] = [];
        for(const a of chipAnchors){
          const pr = m.project([a.lng, a.lat]);
          if(rect && (pr.x < -120 || pr.x > rect.width+120 || pr.y < -120 || pr.y > rect.height+120)) continue;
          chips.push({ x:pr.x, y:pr.y, fid:a.fid, count:a.count, low:a.low, high:a.high, name:a.name });
        }
        setOverlayChips(prev=> sameChips(prev, chips) ? prev : chips);
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
  },[mapLoaded, trackLines, chipAnchors]);

  /* Chip click = select the sortie and frame its colony. Store read at event
     time — closures over store state go stale (the map outlives renders). */
  const handleChipClick = useCallback((fid: string)=>{
    select(fid);
    const m = mapRef.current; if(!m) return;
    try{ m.stop(); }catch{}
    const s = useFootageStore.getState();
    const pts = s.detections.filter(d=> d.footageId===fid && d.status!=="false_positive");
    const b = colonyBounds(pts);
    if (b) {
      try{ m.fitBounds([[b.minLng, b.minLat],[b.maxLng, b.maxLat]], { padding: 80, duration: 420, maxZoom: 13 }); }catch{}
    } else {
      const f = s.footages.find(x=>x.id===fid);
      if (f && Number.isFinite(f.center?.lat) && Number.isFinite(f.center?.lng)) {
        try{ m.easeTo({ center:[f.center.lng, f.center.lat], zoom: Math.max(m.getZoom(), ZOOM_ANIMALS+0.1), duration: 420 }); }catch{}
      }
    }
  },[select]);

  return (
    <div className="relative w-full h-full bg-bg">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Flight tracks — thin, neutral, they are context not content */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-[5]" style={{ overflow:"visible" }}>
        {overlayTracks.map(t=>(
          <polyline
            key={t.id}
            points={t.pts.map(p=>`${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={t.id==="pin" ? "var(--accent)" : t.id===selectedId ? "var(--accent)" : "#ffffff"}
            strokeWidth={t.id===selectedId ? 1.5 : 1}
            strokeOpacity={t.id===selectedId ? 0.9 : 0.28}
            strokeDasharray={t.id===selectedId ? "0" : "5 4"}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>

      {/* Colony chips — the only saturated thing on screen. One per sortie:
          the count, and under it the honest low–high band. In pin mode they
          step back and stop catching clicks meant for the anchor. */}
      <div className={`absolute inset-0 z-[6] pointer-events-none ${pinMode ? "colony-chips-dimmed" : ""}`}>
        {overlayChips.map(c=>{
          const isSel = c.fid===selectedId;
          return (
            <button
              key={c.fid}
              onClick={()=>handleChipClick(c.fid)}
              /* The site's name first when it has one — a chip reading "Kenderli ·
                 218 seals" is a sentence an ecologist can act on; "218 seals"
                 over a dot is a number they have to go and identify. */
              title={[
                c.name,
                c.low!=null
                  ? `${c.count} ${tp(c.count, "unit.seals")} (${t("misc.range", { low: c.low, high: c.high as number })})`
                  : `${c.count} ${tp(c.count, "unit.seals")}`,
              ].filter(Boolean).join(" · ")}
              className={`colony-chip ${isSel ? "selected z-10" : ""}`}
              style={{ left:c.x, top:c.y }}
            >
              <span className="chip-best tnum">{c.count}</span>
              {c.low!=null && c.high!=null && (
                <span className="chip-range tnum">{c.low}–{c.high}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Layer controls */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        {/* fully opaque: over satellite imagery any translucency reads as dirt */}
        <div className="flex items-center gap-0.5 bg-surface border border-line rounded p-0.5 shadow-pop">
          <Toggle checked={satellite} onChange={setSatellite} label={t("map.satellite")} />
          <span className="w-px h-4 bg-line mx-0.5" />
          <Toggle checked={layerState.footprints} onChange={v=>setLayer("footprints",v)} label={t("map.tracks")} />
          <Toggle checked={layerState.detections} onChange={v=>setLayer("detections",v)} label={t("map.colonies")} />
        </div>
        {pinMode && (
          <PinReadout
            value={pinPoints.length ? { lat: pinPoints[0].lat, lng: pinPoints[0].lng } : null}
            zoom={zoomNow}
            onChange={(p)=>{
              setPinPoints([{ t: 0, lat: p.lat, lng: p.lng }]);
              try { useIngestStore.getState().notePin("typed", zoomNow); } catch {}
              const m = mapRef.current;
              if(m){ try{ m.easeTo({ center:[p.lng, p.lat], duration: 250 }); }catch{} }
            }}
          />
        )}
      </div>

      {!mapLoaded && (
        <div className="absolute inset-0 grid place-items-center bg-bg z-20">
          <span className="text-sm text-ink3">{t("map.loading")}</span>
        </div>
      )}
    </div>
  );
}

// The overlay re-projects on every map move and on a timer; bail out of the
// state update when the projection is identical so React can stay idle.
function sameChips(a: ColonyChip[], b: ColonyChip[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    const x=a[i], y=b[i];
    if(x.fid!==y.fid || x.count!==y.count || x.low!==y.low || x.high!==y.high || x.name!==y.name) return false;
    if(Math.abs(x.x-y.x)>0.5 || Math.abs(x.y-y.y)>0.5) return false;
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
  onChange,
}: {
  value: { lat: number; lng: number } | null;
  zoom: number | null;
  onChange: (p: { lat: number; lng: number }) => void;
}) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  const apply = () => {
    // "43.65, 51.18" — comma, semicolon or space, decimal point or comma.
    const m = text.trim().replace(/,(\d)/g, ".$1").match(/^(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)$/);
    const lat = m ? Number(m[1]) : NaN;
    const lng = m ? Number(m[2]) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      setBad(true);
      return;
    }
    setBad(false);
    setText("");
    onChange({ lat, lng });
  };

  return (
    <div className="bg-surface border border-line rounded shadow-pop px-2 py-1.5 max-w-[260px]">
      <div className="text-2xs text-ink3">{value ? t("map.anchorSet") : t("map.clickCentre")}</div>
      {value && (
        <div className="text-xs text-ink tnum font-mono mt-0.5">
          {value.lat.toFixed(3)}, {value.lng.toFixed(3)}
        </div>
      )}
      {/* The precision claim, out loud. Three decimals is about 110 m; the
          zoom says how much of that the gesture could actually see. */}
      <div className="text-2xs text-ink3 mt-0.5 leading-tight">
        {zoom != null ? t("map.pinPrecisionZoom", { z: zoom.toFixed(1) }) : t("map.pinPrecision")}
      </div>
      <div className="flex items-center gap-1 mt-1">
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }}
          placeholder={t("map.coordPlaceholder")}
          aria-label={t("map.coordEnter")}
          className={`w-[132px] h-6 bg-surface2 border rounded px-1.5 text-2xs text-ink font-mono focus:outline-none ${bad ? "border-bad" : "border-line focus:border-ink3"}`}
        />
        <button
          onClick={apply}
          className="h-6 px-2 rounded border border-line bg-surface2 text-2xs text-ink2 hover:text-ink hover:border-ink3 transition-colors"
        >
          {t("map.coordApply")}
        </button>
      </div>
      {bad && <div className="text-2xs text-bad mt-0.5">{t("map.coordBad")}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked:boolean; onChange:(v:boolean)=>void; label:string }){
  return (
    <button
      onClick={()=>onChange(!checked)}
      className={`px-2 h-6 rounded text-2xs transition-colors ${
        checked ? "bg-surface2 text-ink" : "text-ink3 hover:text-ink2"
      }`}
    >
      {label}
    </button>
  );
}
