"use client";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { colonyHull, expandHull, colonyBounds } from "@/lib/colony";
import { countOf } from "@/lib/analytics/count";
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
};

export default function CaspianMap({ onMapReady }: { onMapReady?: (m: any)=>void }) {
  const { t, tp } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const footagesRaw = useFootageStore(s=>s.footages);
  const detectionsRaw = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);
  // Filter by the timeline brush. These MUST be memoised — the overlay effect
  // depends on them, so rebuilding the arrays every render made the effect
  // re-run, setState, and re-render forever.
  const footages = useMemo(()=> {
    if(footagesRaw.length===0) return footagesRaw;
    const dates=footagesRaw.map(f=> new Date(f.uploadedAt).getTime()).sort((a,b)=>a-b);
    const min=Math.min(...dates), max=Math.max(...dates), span=max-min||1;
    const lo=min+span*(timeRange[0]/100), hi=min+span*(timeRange[1]/100);
    return footagesRaw.filter(f=>{ const t=new Date(f.uploadedAt).getTime(); return t>=lo && t<=hi; });
  },[footagesRaw, timeRange]);
  const detections = useMemo(()=> {
    const ids=new Set(footages.map(f=>f.id));
    return detectionsRaw.filter(d=> ids.has(d.footageId));
  },[footages, detectionsRaw]);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const layerState = useFootageStore(s=>s.layerState);
  const setLayer = useFootageStore(s=>s.setLayer);
  const pinMode = useFootageStore(s=>s.pinMode);
  const pinPoints = useFootageStore(s=>s.pinPoints);
  const setPinPoints = useFootageStore(s=>s.setPinPoints);

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

      (window as any).__sealvMap = map;
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
          setPinPoints([{ t: 0, lat: e.lngLat.lat, lng: e.lngLat.lng }]);
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

  // push data to map
  useEffect(()=>{
    const map = mapRef.current; if(!map||!mapLoaded) return;
    const src = map.getSource("footprints") as any;
    if(!src) return;
    const fc: any = {
      type:"FeatureCollection",
      features: footages.filter(f=>layerState.footprints).map(f=>({
        type:"Feature",
        geometry:{ type:"LineString", coordinates: f.track.map(p=>[p.lng, p.lat]) },
        properties:{ id:f.id, selected: f.id===selectedId }
      }))
    };
    // the pinned anchor: one DOM marker, moved or removed per state
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
    src.setData(fc);

    const csrc = map.getSource("colonies") as any;
    const asrc = map.getSource("animals") as any;
    if(!csrc || !asrc) return;
    if(!layerState.detections){
      csrc.setData(EMPTY_FC); asrc.setData(EMPTY_FC);
      return;
    }
    // A false positive is a reviewed "not an animal" — it is out of the
    // outline and out of the dots. Everything else placed is in.
    const placed = detections.filter(d=> d.status!=="false_positive");
    const byFootage = new Map<string, Detection[]>();
    for(const d of placed){
      const arr = byFootage.get(d.footageId);
      if(arr) arr.push(d); else byFootage.set(d.footageId, [d]);
    }
    // Colony outlines: concave hull buffered ~25 m so the line breathes
    // around the animals instead of hugging them. <3 usable points = no
    // polygon exists, and we do not invent one — the chip alone stands.
    const colonyFeatures: any[] = [];
    for(const f of footages){
      const pts = byFootage.get(f.id);
      if(!pts || pts.length < 3) continue;
      const hull = expandHull(colonyHull(pts), 25);
      if(hull.length < 3) continue;
      const ring = hull.map(p=>[p.lng, p.lat]);
      ring.push(ring[0]); // GeoJSON rings close explicitly
      colonyFeatures.push({
        type:"Feature",
        geometry:{ type:"Polygon", coordinates:[ring] },
        properties:{ fid: f.id, selected: f.id===selectedId }
      });
    }
    csrc.setData({ type:"FeatureCollection", features: colonyFeatures });
    const animalFeatures = placed.map(d=>({
      type:"Feature",
      geometry:{ type:"Point", coordinates:[d.lng, d.lat] },
      properties:{ detId:d.id, fid:d.footageId, status:d.status, count:d.count }
    }));
    asrc.setData({ type:"FeatureCollection", features: animalFeatures });
  }, [footages, detections, selectedId, layerState, mapLoaded, pinMode, pinPoints]);

  // fly to selected now handled by click handlers (chip → fitBounds, list → center) to avoid double-ease fighting drag

  // auto-fit when footages first appear (so colonies are on screen at z~7, not z9.2 off-screen)
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    if (footages.length>0 && !selectedId) {
      // compute bounds of all tracks + detections
      let minLng=180, minLat=90, maxLng=-180, maxLat=-90;
      for(const f of footages){ for(const p of f.track){ minLng=Math.min(minLng,p.lng); maxLng=Math.max(maxLng,p.lng); minLat=Math.min(minLat,p.lat); maxLat=Math.max(maxLat,p.lat); } }
      for(const d of detections){ minLng=Math.min(minLng,d.lng); maxLng=Math.max(maxLng,d.lng); minLat=Math.min(minLat,d.lat); maxLat=Math.max(maxLat,d.lat); }
      if (isFinite(minLng)) {
        const pad = 0.15;
        try { map.stop(); map.fitBounds([[minLng-pad, minLat-pad],[maxLng+pad, maxLat+pad]], { padding: 40, duration: 520, maxZoom: ZOOM_COLONY }); } catch{}
        console.log(`[SEALv] fitBounds ${footages.length}F ${detections.length}G -> [[${minLng.toFixed(2)},${minLat.toFixed(2)}],[${maxLng.toFixed(2)},${maxLat.toFixed(2)}]] zoom=${map.getZoom().toFixed(2)}`);
      }
    }
  },[footages.length, detections.length, mapLoaded, selectedId]);

  // debug: log every push
  useEffect(()=>{
    if(!mapLoaded) return;
    console.log(`[SEALv] push ${footages.length} footages, ${detections.length} detections, layers`, layerState, "zoom", mapRef.current?.getZoom?.()?.toFixed(2));
  },[footages.length, detections.length, layerState, mapLoaded]);

  /* DOM overlay — tracks and colony chips. Projected on move/zoom/resize (and
     a slow safety timer), guaranteed visible even if GL layers/glyphs fail. */
  const [overlayChips, setOverlayChips] = useState<ColonyChip[]>([]);
  const [overlayTracks, setOverlayTracks] = useState<Array<{pts:Array<{x:number,y:number}>, id:string}>>([]);
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    const update = ()=>{
      if(!mapRef.current) return;
      const m = mapRef.current;
      // tracks — project each point
      const tTracks: Array<{pts:Array<{x:number,y:number}>, id:string}> = [];
      if (layerState.footprints) {
        // use filtered footages (timeRange) for overlay — read from current closure footages
        for(const f of footages){
          const pts = f.track.map(p=>{
            try{ const pr=m.project([p.lng,p.lat]); return {x:pr.x, y:pr.y}; }catch{ return null as any; }
          }).filter(Boolean);
          if(pts.length>1) tTracks.push({ pts, id:f.id });
        }
        // a single pinned anchor has no path to overlay
      }
      setOverlayTracks(prev=> sameTracks(prev, tTracks) ? prev : tTracks);
      // chips — one per sortie: the count with its band, anchored at the
      // centre of the colony's bounding box (fallback: the sortie centre)
      if (!layerState.detections) { setOverlayChips([]); return; }
      const byFootage = new Map<string, {pts: Detection[]; sum: number}>();
      for(const d of detections){
        if(d.status==="false_positive") continue;
        let e = byFootage.get(d.footageId);
        if(!e){ e = { pts: [], sum: 0 }; byFootage.set(d.footageId, e); }
        e.pts.push(d); e.sum += d.count;
      }
      let rect: { width: number; height: number } | null = null;
      try{ rect = m.getCanvas().getBoundingClientRect(); }catch{}
      const chips: ColonyChip[] = [];
      for(const f of footages){
        const entry = byFootage.get(f.id);
        // The count the platform stands behind, from the one shared definition:
        // the engine's best estimate, else the surviving detections plus the
        // animals it counted but could not place. `entry` still supplies the
        // GEOMETRY below - where to anchor the chip - but not the number, so
        // the chip over a colony and the inspector's headline for that same
        // sortie can never be two different figures.
        const count = countOf(f);
        const b = entry ? colonyBounds(entry.pts) : null;
        const lat = b ? (b.minLat+b.maxLat)/2 : f.center?.lat;
        const lng = b ? (b.minLng+b.maxLng)/2 : f.center?.lng;
        if(!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        let x=0, y=0;
        try{ const pr=m.project([lng as number, lat as number]); x=pr.x; y=pr.y; }catch{ continue; }
        if(rect && (x < -120 || x > rect.width+120 || y < -120 || y > rect.height+120)) continue;
        const hasBand = f.band != null && f.band.low != null && f.band.high != null && f.band.low !== f.band.high;
        chips.push({
          x, y, fid: f.id,
          count,
          low: hasBand ? f.band!.low : null,
          high: hasBand ? f.band!.high : null,
        });
      }
      setOverlayChips(prev=> sameChips(prev, chips) ? prev : chips);
    };
    update();
    map.on("move", update);
    map.on("zoom", update);
    map.on("resize", update);
    const id = setInterval(update, 600);
    return ()=>{ try{ map.off("move",update); map.off("zoom",update); map.off("resize",update);}catch{} clearInterval(id); };
  },[mapLoaded, footages, detections, layerState, pinMode, pinPoints, selectedId]);

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
              title={c.low!=null ? `${c.count} ${tp(c.count, "unit.seals")} (${t("misc.range", { low: c.low, high: c.high as number })})` : `${c.count} ${tp(c.count, "unit.seals")}`}
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
          <div className="bg-accent text-accent-ink text-xs px-2.5 h-7 rounded flex items-center">
            {pinPoints.length ? t("map.anchorSet") : t("map.clickCentre")}
          </div>
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
    if(x.fid!==y.fid || x.count!==y.count || x.low!==y.low || x.high!==y.high) return false;
    if(Math.abs(x.x-y.x)>0.5 || Math.abs(x.y-y.y)>0.5) return false;
  }
  return true;
}
function sameTracks(a:any[], b:any[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    if(a[i].id!==b[i].id || a[i].pts.length!==b[i].pts.length) return false;
    const p=a[i].pts[0], q=b[i].pts[0];
    if(Math.abs(p.x-q.x)>0.5 || Math.abs(p.y-q.y)>0.5) return false;
  }
  return true;
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
