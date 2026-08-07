import type { TrackPoint } from "../types";
import { snapToWater, isWater } from "../caspian";

/**
 * Try to extract GPS from inside the MP4 itself (no sidecar).
 * Supports:
 *  - DJI XMP inside moov/udta (plain text GPS( lat,lng) or [latitude: ] inside the file)
 *  - iPhone/Android com.apple.quicktime.location / creation location (ISO6709 +43.1234+051.1234/)
 *  - Generic XMP <GPSLatitude> / <Location> tags
 *
 * Strategy: read first ~2MB + last ~256KB as text (XMP is plain XML at head or tail)
 * and regex for lat/lng. No mp4box dep — lightweight and works for hack demo.
 * If only one fix found, we synthesize a 30km track around it so the footprint is visible.
 */
export type MP4Location = {
  /** Track ready to ingest — null when nothing usable was found. */
  track: TrackPoint[] | null;
  /** First coordinate found in the file, exactly as written. Reported to the
   *  user even when it is outside the survey area, so "no GPS" is never
   *  claimed about a video that plainly has GPS in it. */
  found: { lat: number; lng: number } | null;
  /** True when GPS exists but falls outside the Caspian survey area. */
  outsideSurveyArea: boolean;
  /** How many distinct fixes were recovered. */
  fixes: number;
};

/** Survey area — the map's own bounds. Coordinates outside it are still
 *  reported, just not plotted. */
function inSurveyArea(lat:number, lng:number){
  return lat>=36 && lat<=48 && lng>=46 && lng<=56;
}

export async function parseMP4Metadata(file: File): Promise<MP4Location> {
  // read head + tail
  const headSize = Math.min(file.size, 2 * 1024 * 1024);
  const tailSize = Math.min(file.size, 512 * 1024);
  const head = await file.slice(0, headSize).arrayBuffer();
  const tail = file.size > headSize ? await file.slice(file.size - tailSize).arrayBuffer() : new ArrayBuffer(0);
  const combined = new Uint8Array(headSize + tailSize);
  combined.set(new Uint8Array(head), 0);
  if (tailSize) combined.set(new Uint8Array(tail), headSize);
  // decode as latin1 to keep bytes searchable (XMP is ascii)
  let text = "";
  try { text = new TextDecoder("utf-8", { fatal: false }).decode(combined); } catch { text = Array.from(combined).map(b=> String.fromCharCode(b)).join(""); }
  // also try latin1 fallback for binary-safe search
  const latin = Array.from(combined).map(b=> b>=32 && b<=126 ? String.fromCharCode(b) : " ").join("");

  const candidates: Array<{lat:number,lng:number, alt?:number}> = [];
  const anyFound: Array<{lat:number,lng:number}> = [];

  // 1) DJI-style inside MP4: GPS(44.123, 50.123) or [latitude: 44.123] [longitude: 50.123]
  const reGPS = /GPS\s*\(\s*([+-]?\d+\.\d+)\s*,\s*([+-]?\d+\.\d+)(?:\s*,\s*([+-]?\d+\.?\d*))?/gi;
  const reLatLonBracket = /\[latitude:\s*([+-]?\d+\.\d+)\]\s*\[longitude:\s*([+-]?\d+\.\d+)\]/gi;
  const reLatLonTag = /<(?:GPSLatitude|latitude|lat)>\s*([+-]?\d+\.\d+)\s*<\/(?:GPSLatitude|latitude|lat)>\s*<(?:GPSLongitude|longitude|lon)>\s*([+-]?\d+\.\d+)\s*<\/(?:GPSLongitude|longitude|lon)>/gi;
  const reISO6709 = /([+-]\d+\.\d+)([+-]\d+\.\d+)(?:[+-]\d+\.?\d*)?\//g; // +43.1234+051.1234/
  const reQuickTime = /com\.apple\.quicktime\.location[^+]*([+-]\d+\.\d+)([+-]\d+\.\d+)/gi;
  const reXmpLatLon = /exif:GPSLatitude[^0-9]*([+-]?\d+\.\d+)[^0-9]+exif:GPSLongitude[^0-9]*([+-]?\d+\.\d+)/gi;

  // 0) Binary 3GPP `loci` box (what ffmpeg and many Android cameras write).
  //    Stored as fixed-point, so no amount of text matching will find it.
  for(const p of parseLociBoxes(combined)) pushCand(p.lat, p.lng, p.alt);

  const sources = [text, latin];
  for(const src of sources){
    let m: RegExpExecArray | null;
    while((m=reGPS.exec(src))){ pushCand(parseFloat(m[1]), parseFloat(m[2]), m[3]?parseFloat(m[3]):undefined); }
    reGPS.lastIndex=0;
    while((m=reLatLonBracket.exec(src))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
    reLatLonBracket.lastIndex=0;
    while((m=reLatLonTag.exec(src))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
    reLatLonTag.lastIndex=0;
    while((m=reQuickTime.exec(src))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
    reQuickTime.lastIndex=0;
    while((m=reXmpLatLon.exec(src))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
    reXmpLatLon.lastIndex=0;
    // ISO6709 — be careful: many numbers, only take those near Caspian
    while((m=reISO6709.exec(src))){
      const lat=parseFloat(m[1]), lng=parseFloat(m[2]);
      if(!isNaN(lat)&&!isNaN(lng)) pushCand(lat,lng);
    }
    reISO6709.lastIndex=0;
  }

  function pushCand(lat:number,lng:number, alt?:number){
    if(isNaN(lat)||isNaN(lng)) return;
    if(lat< -90 || lat > 90 || lng < -180 || lng > 180) return;
    // Record every plausible fix, wherever on earth it is — the caller needs to
    // be able to say "GPS found at X, but outside the survey area".
    if(!anyFound.some(c=> Math.abs(c.lat-lat)<0.0005 && Math.abs(c.lng-lng)<0.0005)) anyFound.push({lat,lng});
    if(!inSurveyArea(lat,lng)) return;
    // de-duplicate close points (0.0005° ~50m)
    if(candidates.some(c=> Math.abs(c.lat-lat)<0.0005 && Math.abs(c.lng-lng)<0.0005)) return;
    if(candidates.length>60) return;
    candidates.push({lat,lng,alt});
  }

  if(candidates.length===0){
    return {
      track: null,
      found: anyFound[0] ?? null,
      outsideSurveyArea: anyFound.length > 0,
      fixes: anyFound.length,
    };
  }

  // if many points found (e.g., XMP with per-frame GPS), build track with t spread
  if(candidates.length>=3){
    // sort by lat jitter to simulate time order — XMP order is already time order
    const track: TrackPoint[] = candidates.map((c,i)=> ({
      t: (i/(candidates.length-1))*90,
      lat: c.lat, lng: c.lng, alt: c.alt ?? 75,
    }));
    // snap any land pts to water
    const snapped = track.map(p=> isWater(p.lat,p.lng) ? p : { ...snapToWater(p.lat,p.lng), t:p.t, alt:p.alt });
    return { track: snapped, found: candidates[0], outsideSurveyArea: false, fixes: candidates.length };
  }

  // single fix (iPhone location) — synthesize a 30km offshore track around it so footprint is visible
  const center = candidates[0];
  const rawCenter = isWater(center.lat, center.lng) ? center : snapToWater(center.lat, center.lng);
  // generate small synthetic track (same logic as lib/mock but inline to avoid circular dep)
  const pts: TrackPoint[] = [];
  let lat=rawCenter.lat, lng=rawCenter.lng;
  for(let i=0;i<40;i++){
    const t=(i/40)*90;
    let nlat=lat + (Math.sin(i*0.5)*0.008 + (Math.random()-0.5)*0.004);
    let nlng=lng + (Math.cos(i*0.7)*0.008 + (Math.random()-0.5)*0.004);
    if(!isWater(nlat,nlng)){
      const toward={ lat: lat + (rawCenter.lat-lat)*0.4, lng: lng + (rawCenter.lng-lng)*0.4 };
      if(isWater(toward.lat,toward.lng)){ nlat=toward.lat; nlng=toward.lng; }
      else { const s=snapToWater(nlat,nlng, rawCenter); nlat=s.lat; nlng=s.lng; }
    }
    lat=nlat; lng=nlng;
    pts.push({ t, lat, lng, alt: center.alt ?? 75 });
  }
  return { track: pts, found: { lat: center.lat, lng: center.lng }, outsideSurveyArea: false, fixes: 1 };
}

/**
 * Scan raw bytes for 3GPP `loci` boxes and decode the fixed-point coordinates.
 *
 * Layout after the box header: version(1) flags(3) language(2)
 * name(null-terminated UTF-8) role(1) longitude(4) latitude(4) altitude(4).
 * Longitude comes first, and all three are 16.16 signed fixed-point.
 */
function parseLociBoxes(bytes: Uint8Array): Array<{lat:number; lng:number; alt?:number}> {
  const out: Array<{lat:number; lng:number; alt?:number}> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fixed = (offset: number) => view.getInt32(offset, false) / 65536;

  for (let i = 0; i + 4 <= bytes.length; i++) {
    // 'loci'
    if (bytes[i] !== 0x6c || bytes[i+1] !== 0x6f || bytes[i+2] !== 0x63 || bytes[i+3] !== 0x69) continue;

    let p = i + 4 + 1 + 3 + 2; // skip type, version, flags, language
    while (p < bytes.length && bytes[p] !== 0x00) p++; // name
    p++;                                               // its terminator
    p++;                                               // role

    if (p + 8 > bytes.length) continue;
    const lng = fixed(p);
    const lat = fixed(p + 4);
    const alt = p + 12 <= bytes.length ? fixed(p + 8) : undefined;

    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
      out.push({ lat, lng, alt: alt && alt > 0 && alt < 10000 ? alt : undefined });
    }
  }
  return out;
}
