"use client";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";

// Caspian bounds
const CASPIAN_BOUNDS: [[number, number],[number,number]] = [[46,36],[55,48]];
const AKTAU: [number, number] = [51.18, 43.65];

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
    { id: "bg", type: "background", paint: { "background-color": "#0a0a0b" } },
    // Dial the basemap right down — it is context, and the counts drawn on top
    // are the only things that should carry contrast.
    { id: "osm", type: "raster", source: "osm", paint: {
      "raster-opacity": 1,
      "raster-brightness-max": 0.72,
      "raster-saturation": -0.45,
      "raster-contrast": 0.05,
    } },
  ],
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
};

export default function CaspianMap({ onMapReady }: { onMapReady?: (m: any)=>void }) {
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

  const initMap = useCallback(async ()=>{
    if (!containerRef.current || mapRef.current) return;
    const ml = await import("maplibre-gl");
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
      // Add sources for our data — high-visibility Palantir style
      map.addSource("footprints", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addSource("detections", { type: "geojson", data: { type:"FeatureCollection", features: [] } });
      map.addLayer({ id: "footprints-line", type:"line", source:"footprints", paint:{ "line-color":"#ffffff", "line-width":1, "line-opacity":0.3 } });
      map.addLayer({ id:"footprints-fill", type:"fill", source:"footprints", paint:{ "fill-color":"#ffffff", "fill-opacity":0.04 } });
      // heatmap — density of seals (count-weighted points duplicated)
      map.addSource("heatmap-src", { type:"geojson", data: { type:"FeatureCollection", features: [] } });
      map.addLayer({ id:"seal-heat", type:"heatmap", source:"heatmap-src", paint:{
        "heatmap-weight": ["interpolate",["linear"],["get","count"],1,0.3,12,1],
        "heatmap-intensity": ["interpolate",["linear"],["zoom"],5,0.6,8,1.2,10,1.8],
        "heatmap-radius": ["interpolate",["linear"],["zoom"],5,18,8,28,10,38],
        "heatmap-opacity": 0.8,
        "heatmap-color": ["interpolate",["linear"],["heatmap-density"],0,"rgba(224,161,60,0)",0.3,"rgba(224,161,60,0.28)",0.6,"rgba(224,161,60,0.55)",1,"rgba(240,196,120,0.85)"]
      }});
      map.setLayoutProperty("seal-heat","visibility","none");
      // outer glow
      map.addLayer({ id:"detections-glow", type:"circle", source:"detections", paint:{
        "circle-radius": ["interpolate",["linear"],["get","count"],1,12,4,15,12,20],
        "circle-color": "#e0a13c",
        "circle-opacity": 0.16,
        "circle-blur": 0.6
      }});
      map.addLayer({ id:"detections-circle", type:"circle", source:"detections", paint:{
        "circle-radius": ["interpolate",["linear"],["get","count"],1,7,4,10,12,16],
        "circle-color": ["case",["==",["get","selected"],true],"#e0a13c", ["==",["get","status"],"false_positive"],"#4a4a52","#ffffff"],
        "circle-stroke-color": "rgba(0,0,0,0.6)",
        "circle-stroke-width": 1,
        "circle-opacity": 1
      }});
      // cluster-like count label — robust glyphs with fallback, no crash if font missing
      try {
        map.addLayer({ id:"detections-count", type:"symbol", source:"detections", layout:{ "text-field":["to-string",["get","count"]], "text-size":11, "text-font":["Noto Sans Bold","Open Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true }, paint:{ "text-color":"#0a0a0b", "text-halo-color":"rgba(255,255,255,0.9)","text-halo-width":0.9, "text-halo-blur":0 } });
      } catch(e){ console.warn("symbol layer failed", e); }

      (window as any).__sealvMap = map;
      setMapLoaded(true);
      onMapReady?.(map);

      // Pin-mode click handler. The map is created once (the init guard above
      // bails on re-runs), so anything these closures capture is frozen at
      // first render - `pinMode` here was ALWAYS false and manual pinning
      // never registered a single point. Read the store at event time, the
      // way the pinPoints line below already had to.
      map.on("click", (e: any)=>{
        if (useFootageStore.getState().pinMode) {
          const prev = useFootageStore.getState().pinPoints;
          const t = prev.length;
          const next = [...prev, { t, lat: e.lngLat.lat, lng: e.lngLat.lng }];
          setPinPoints(next);
        }
      });
      map.on("click","detections-circle",(e: any)=>{
        if(useFootageStore.getState().pinMode) return;
        const f = e.features?.[0];
        const detId = (f?.properties as any)?.detId as string;
        if(detId){
          const det = useFootageStore.getState().detections.find(d=>d.id===detId);
          if(det) select(det.footageId);
        }
      });
      map.on("mouseenter","detections-circle",()=> map.getCanvas().style.cursor="pointer");
      map.on("mouseleave","detections-circle",()=> map.getCanvas().style.cursor= useFootageStore.getState().pinMode?"crosshair":"");
    });
    mapRef.current = map;
    return ()=> map.remove();
  }, [pinMode, setPinPoints, select, onMapReady]);

  useEffect(()=>{ initMap(); },[initMap]);

  // update cursor when pinMode toggles
  useEffect(()=>{
    if (mapRef.current) mapRef.current.getCanvas().style.cursor = pinMode ? "crosshair" : "";
  }, [pinMode]);

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

  // heatmap toggle
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    const vis = layerState.heatmap ? "visible" : "none";
    try{
      if(map.getLayer("seal-heat")) map.setLayoutProperty("seal-heat","visibility",vis);
      // dim dots when heatmap on
      if(map.getLayer("detections-circle")) map.setPaintProperty("detections-circle","circle-opacity", layerState.heatmap ? 0.35 : 1);
      if(map.getLayer("detections-glow")) map.setPaintProperty("detections-glow","circle-opacity", layerState.heatmap ? 0.05 : 0.18);
    }catch{}
  },[layerState.heatmap, mapLoaded]);

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
    // add pin track as extra line if in pin mode
    if (pinMode && pinPoints.length>1) {
      (fc.features as any).push({ type:"Feature", geometry:{ type:"LineString", coordinates: pinPoints.map(p=>[p.lng,p.lat]) }, properties:{ id:"pin-track", selected:false } });
    }
    src.setData(fc);

    // detections: naive clustering by grid (0.05 deg ~ 5km). For MVP we cluster manually: group detections within 0.04 deg
    const dsrc = map.getSource("detections") as any;
    if(!dsrc) return;
    if(!layerState.detections && !layerState.clusters) {
      dsrc.setData({type:"FeatureCollection", features:[]});
      return;
    }
    // Build clusters if enabled and zoom < 9.5
    const zoom = map.getZoom();
    const doCluster = layerState.clusters && zoom < 9.5 && detections.length>0;
    let features: any[] = [];
    if (doCluster) {
      // simple grid clustering
      const grid = new Map<string, DetectionCluster>();
      const cell = 0.06; // deg
      for(const d of detections){
        const key = `${Math.floor(d.lat/cell)}_${Math.floor(d.lng/cell)}`;
        if(!grid.has(key)) grid.set(key,{ lat:0,lng:0,count:0, ids:[], members:[] });
        const g=grid.get(key)!;
        g.lat+=d.lat; g.lng+=d.lng; g.count+=d.count; g.ids.push(d.id); g.members.push(d);
      }
      for(const [k,g] of grid){
        const n=g.members.length;
        const avgLat=g.lat/n, avgLng=g.lng/n;
        const isSingle = n===1;
        if(isSingle && layerState.detections){
          const d=g.members[0];
          features.push({ type:"Feature", geometry:{type:"Point", coordinates:[d.lng,d.lat]}, properties:{ detId:d.id, count:d.count, status:d.status, selected: d.footageId===selectedId } });
        } else {
          features.push({ type:"Feature", geometry:{type:"Point", coordinates:[avgLng,avgLat]}, properties:{ detId:g.ids[0], count:g.count, status:"cluster", selected: false, cluster: true, clusterCount: n } });
        }
      }
      // hide cluster count label tweak: clusters use count = sum seals
    } else {
      features = detections.filter(()=>layerState.detections).map(d=>({
        type:"Feature",
        geometry:{type:"Point", coordinates:[d.lng,d.lat]},
        properties:{ detId:d.id, count:d.count, status:d.status, selected: d.footageId===selectedId }
      }));
    }
    dsrc.setData({type:"FeatureCollection", features});
    // heatmap source — same points, weight by count
    const hsrc = map.getSource("heatmap-src") as any;
    if(hsrc){
      hsrc.setData({type:"FeatureCollection", features: features.map((f:any)=> ({...f, properties:{...f.properties, count:f.properties.count}}))});
    }
  }, [footages, detections, selectedId, layerState, mapLoaded, pinMode, pinPoints]);

  // fly to selected now handled by click handlers (dot → dot, list → center) to avoid double-ease fighting drag
  // kept for programmatic select without map click — but only when not already animating to a dot
  // (removed auto easeTo to fix "can't drag after select" — overlay handleClick does the zoom)

  // auto-fit when footages first appear (so dots are on screen at z~7, not z9.2 off-screen)
  useEffect(()=>{
    const map=mapRef.current; if(!map||!mapLoaded) return;
    if (footages.length>0 && !selectedId) {
      // compute bounds of all tracks + detections
      let minLng=180, minLat=90, maxLng=-180, maxLat=-90;
      for(const f of footages){ for(const p of f.track){ minLng=Math.min(minLng,p.lng); maxLng=Math.max(maxLng,p.lng); minLat=Math.min(minLat,p.lat); maxLat=Math.max(maxLat,p.lat); } }
      for(const d of detections){ minLng=Math.min(minLng,d.lng); maxLng=Math.max(maxLng,d.lng); minLat=Math.min(minLat,d.lat); maxLat=Math.max(maxLat,d.lat); }
      if (isFinite(minLng)) {
        const pad = 0.15;
        try { map.stop(); map.fitBounds([[minLng-pad, minLat-pad],[maxLng+pad, maxLat+pad]], { padding: 40, duration: 520, maxZoom: 8.2 }); } catch{}
        console.log(`[SEALv] fitBounds ${footages.length}F ${detections.length}G -> [[${minLng.toFixed(2)},${minLat.toFixed(2)}],[${maxLng.toFixed(2)},${maxLat.toFixed(2)}]] zoom=${map.getZoom().toFixed(2)}`);
      }
    }
  },[footages.length, detections.length, mapLoaded, selectedId]);

  // debug: log every push
  useEffect(()=>{
    if(!mapLoaded) return;
    console.log(`[SEALv] push ${footages.length} footages, ${detections.length} detections, layers`, layerState, "zoom", mapRef.current?.getZoom?.()?.toFixed(2));
  },[footages.length, detections.length, layerState, mapLoaded]);

  // DOM fallback overlay — guaranteed visible even if MapLibre layers/glyphs fail
  const [overlayDots, setOverlayDots] = useState<Array<{x:number,y:number,lat:number,lng:number,count:number,id:string,fid:string,cluster?:boolean,label?:boolean}>>([]);
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
        if (pinMode && pinPoints.length>1) {
          const pts = pinPoints.map(p=>{ try{ const pr=m.project([p.lng,p.lat]); return {x:pr.x,y:pr.y}; }catch{ return null as any; } }).filter(Boolean);
          if(pts.length>1) tTracks.push({ pts, id:"pin" });
        }
      }
      setOverlayTracks(prev=> sameTracks(prev, tTracks) ? prev : tTracks);
      // dots / clusters — reuse same clustering logic as layers for consistency
      if (!layerState.detections && !layerState.clusters) { setOverlayDots([]); return; }
      const dets = detections;
      const zoom = m.getZoom();
      const doCluster = layerState.clusters && zoom < 9.5 && dets.length>0;
      let feats: Array<{lat:number,lng:number,count:number,id:string,fid:string,cluster?:boolean}> = [];
      if (doCluster) {
        const cell=0.06; const grid=new Map<string,{lat:number,lng:number,count:number,ids:string[],fids:string[]}>();
        for(const d of dets){
          const key=`${Math.floor(d.lat/cell)}_${Math.floor(d.lng/cell)}`;
          if(!grid.has(key)) grid.set(key,{lat:0,lng:0,count:0,ids:[],fids:[]});
          const g=grid.get(key)!; g.lat+=d.lat; g.lng+=d.lng; g.count+=d.count; g.ids.push(d.id); g.fids.push(d.footageId);
        }
        for(const g of grid.values()){
          const n=g.ids.length; const avgLat=g.lat/n, avgLng=g.lng/n;
          const isSingle=n===1;
          if(isSingle && layerState.detections) feats.push({lat:avgLat,lng:avgLng,count:g.count,id:g.ids[0],fid:g.fids[0]});
          else if(!isSingle) feats.push({lat:avgLat,lng:avgLng,count:g.count,id:g.ids[0],fid:g.fids[0],cluster:true});
        }
      } else {
        if(layerState.detections) feats = dets.map(d=>({lat:d.lat,lng:d.lng,count:d.count,id:d.id,fid:d.footageId}));
      }
      const projected = feats.map(f=>{
        try{
          const pr=m.project([f.lng,f.lat]);
          const { width, height } = m.getCanvas().getBoundingClientRect();
          if(pr.x < -80 || pr.x > width+80 || pr.y < -80 || pr.y > height+80) return null;
          return {x:pr.x,y:pr.y,lat:f.lat,lng:f.lng,count:f.count,id:f.id,fid:f.fid,cluster:f.cluster};
        }catch{ return null; }
      }).filter(Boolean) as Array<{x:number,y:number,lat:number,lng:number,count:number,id:string,fid:string,cluster?:boolean,label?:boolean}>;

      // Label collision: at low zoom the count chips pile on top of each other and
      // the map turns to mush. Keep the dot for every detection, but only show the
      // number where it has room — biggest counts and clusters win the space.
      const placed: Array<{x:number,y:number}> = [];
      const ranked = [...projected].sort((a,b)=> (b.cluster?1:0)-(a.cluster?1:0) || b.count-a.count);
      for(const f of ranked){
        const clash = placed.some(p=> Math.abs(p.x-f.x) < 34 && Math.abs(p.y-f.y) < 15);
        f.label = !clash;
        if(!clash) placed.push({x:f.x, y:f.y});
      }
      setOverlayDots(prev=> sameDots(prev, projected) ? prev : (projected as any));
    };
    update();
    map.on("move", update);
    map.on("zoom", update);
    map.on("resize", update);
    const id = setInterval(update, 600);
    return ()=>{ try{ map.off("move",update); map.off("zoom",update); map.off("resize",update);}catch{} clearInterval(id); };
  },[mapLoaded, footages, detections, layerState, pinMode, pinPoints, selectedId]);
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

      {/* Counts — the only saturated thing on screen */}
      <div className="absolute inset-0 z-[6] pointer-events-none">
        {overlayDots.map(d=>{
          const isSel = d.fid===selectedId;
          const isCluster = !!d.cluster;
          const handleClick = ()=>{
            select(d.fid);
            const m = mapRef.current; if(!m) return;
            try{ m.stop(); }catch{}
            const targetZoom = isCluster ? Math.min(10.5, Math.max(m.getZoom()+1.6, 9.2)) : Math.max(m.getZoom(), 11);
            m.easeTo({ center:[d.lng, d.lat], zoom: targetZoom, duration: 320 });
          };

          if (isCluster) {
            return (
              <button
                key={d.id}
                onClick={handleClick}
                title={`${d.count} seals across ${d.cluster} sorties`}
                className="absolute pointer-events-auto -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 px-2 h-[22px] rounded-full bg-accent text-accent-ink hover:brightness-110 transition-[filter] shadow-pop"
                style={{ left:d.x, top:d.y }}
              >
                <span className="text-xs font-medium tnum leading-none">{d.count}</span>
              </button>
            );
          }

          return (
            <button
              key={d.id}
              onClick={handleClick}
              title={`${d.count} seals`}
              className={`absolute pointer-events-auto -translate-x-1/2 -translate-y-1/2 group flex items-center ${isSel ? "z-10" : ""}`}
              style={{ left:d.x, top:d.y }}
            >
              <span
                className={`w-[7px] h-[7px] rounded-full shrink-0 transition-colors ${
                  isSel
                    ? "bg-accent ring-[3px] ring-accent/25"
                    : "bg-white ring-1 ring-black/60 group-hover:bg-accent"
                }`}
              />
              {(d.label || isSel) && (
                <span
                  className={`ml-1.5 px-1 rounded text-2xs tnum leading-[14px] whitespace-nowrap transition-colors ${
                    isSel ? "bg-accent text-accent-ink" : "bg-black/65 text-white group-hover:bg-black/85"
                  }`}
                >
                  {d.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Layer controls */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        <div className="flex items-center gap-0.5 bg-surface/95 backdrop-blur border border-line rounded p-0.5">
          <Toggle checked={satellite} onChange={setSatellite} label="Satellite" />
          <span className="w-px h-4 bg-line mx-0.5" />
          <Toggle checked={layerState.footprints} onChange={v=>setLayer("footprints",v)} label="Tracks" />
          <Toggle checked={layerState.detections} onChange={v=>setLayer("detections",v)} label="Counts" />
          <Toggle checked={layerState.clusters} onChange={v=>setLayer("clusters",v)} label="Cluster" />
          <Toggle checked={layerState.heatmap} onChange={v=>setLayer("heatmap",v)} label="Heat" />
        </div>
        {pinMode && (
          <div className="bg-accent text-accent-ink text-xs px-2.5 h-7 rounded flex items-center">
            Click the map to draw a path · {pinPoints.length} pts
          </div>
        )}
      </div>

      {!mapLoaded && (
        <div className="absolute inset-0 grid place-items-center bg-bg z-20">
          <span className="text-sm text-ink3">Loading chart…</span>
        </div>
      )}
    </div>
  );
}

type DetectionCluster = { lat:number; lng:number; count:number; ids:string[]; members: any[] };

// The overlay re-projects on every map move and on a timer; bail out of the
// state update when the projection is identical so React can stay idle.
function sameDots(a:any[], b:any[]){
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i++){
    const x=a[i], y=b[i];
    if(x.id!==y.id || x.count!==y.count || x.label!==y.label || x.cluster!==y.cluster) return false;
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
