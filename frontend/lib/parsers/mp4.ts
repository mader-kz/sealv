import type { TrackPoint } from "../types";

/**
 * Try to extract GPS from inside the MP4 itself (no sidecar).
 * Supports:
 *  - DJI XMP inside moov/udta (plain text GPS( lat,lng) or [latitude: ] inside the file)
 *  - iPhone/Android com.apple.quicktime.location / ©xyz (ISO-6709 +43.1234+051.1234/)
 *  - Generic XMP <GPSLatitude> / <Location> tags
 *  - The binary 3GPP `loci` box ffmpeg and many Android cameras write
 *
 * Strategy: read the first ~2MB + last ~512KB and decode them ONCE as latin1
 * (a 1:1 byte→char map, so ASCII metadata embedded in binary stays
 * searchable), then regex for lat/lng. No mp4box dep.
 *
 * What this parser does NOT do is invent geometry. Every point it returns is a
 * coordinate the file actually carries, unmoved. It used to spin a single fix
 * into a forty-point random walk — reported to the operator as "40 track
 * points" and uploaded as the sidecar the service georeferences every animal
 * against — and to push any point the water mask disliked up to ~33 km. One
 * fix is one anchor; the consensus lays the animals out around it by their
 * real pixel offsets.
 */
export type MP4Location = {
  /** Track ready to ingest — null when nothing usable was found. One entry per
   *  fix the file carries, in file order, at the coordinates it carries. */
  track: TrackPoint[] | null;
  /** First coordinate found in the file, exactly as written. Reported to the
   *  user even when it is outside the survey area, so "no GPS" is never
   *  claimed about a video that plainly has GPS in it. */
  found: { lat: number; lng: number } | null;
  /** True when GPS exists but falls outside the Caspian survey area. */
  outsideSurveyArea: boolean;
  /** How many distinct fixes were recovered. */
  fixes: number;
  /** True when the track's `t` values were spread evenly instead of read: the
   *  POSITIONS are measured, their timing is not, and the UI says so. */
  timesSynthesized: boolean;
};

/** Seconds several fixes are spread across when the file gives positions but
 *  no timing. Dropzone rescales this onto the video's real duration. */
const SYNTHETIC_SPREAD_S = 90;

/* ISO-6709 is two signs and a handful of digits — a pattern that a compressed
   video stream produces by coincidence, inside the very lat 36-48 / lng 46-56
   box the survey filter allows, and it was then reported as a GPS fix. So it is
   only looked for where the format actually puts it: the QuickTime location
   keys, or right after a `©xyz` atom (0xA9 "xyz", one byte per char under the
   latin1 decode). A match found loose in the byte stream is noise wearing a
   coordinate's clothes.

   The keys/ilst layout, where the key name and its value sit in separate boxes
   too far apart for this window, is still covered by `reQuickTime` below —
   which scans the whole text exactly as it did before. */
const ISO6709_CONTAINERS = ["com.apple.quicktime.location", "©xyz"];
const ISO6709_WINDOW = 96;

function iso6709Windows(text: string): string[] {
  const out: string[] = [];
  for (const marker of ISO6709_CONTAINERS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at < 0) break;
      out.push(text.slice(at, at + marker.length + ISO6709_WINDOW));
      from = at + marker.length;
      if (out.length >= 32) return out;
    }
  }
  return out;
}

/** Survey area — the map's own bounds. Coordinates outside it are still
 *  reported, just not plotted. */
function inSurveyArea(lat:number, lng:number){
  return lat>=36 && lat<=48 && lng>=46 && lng<=56;
}

export async function parseMP4Metadata(file: File): Promise<MP4Location> {
  // read head + tail
  const headSize = Math.min(file.size, 2 * 1024 * 1024);
  const tailSize = file.size > headSize ? Math.min(file.size, 512 * 1024) : 0;
  const head = await file.slice(0, headSize).arrayBuffer();
  const tail = tailSize ? await file.slice(file.size - tailSize).arrayBuffer() : new ArrayBuffer(0);
  const combined = new Uint8Array(headSize + tailSize);
  combined.set(new Uint8Array(head), 0);
  if (tailSize) combined.set(new Uint8Array(tail), headSize);
  /* ONE decode, ONE string. latin1 maps every byte to exactly one character,
     so ASCII metadata inside binary is searchable without a second copy. The
     old code built a 2.5-million-element array and joined it into a second
     full-size string, then ran six global regexes over both — twelve full
     scans of 2.5 MB on the main thread, per dropped file. Its try/catch was
     dead too: TextDecoder with fatal:false cannot throw. */
  const text = new TextDecoder("latin1").decode(combined);

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

  let m: RegExpExecArray | null;
  while((m=reGPS.exec(text))){ pushCand(parseFloat(m[1]), parseFloat(m[2]), m[3]?parseFloat(m[3]):undefined); }
  reGPS.lastIndex=0;
  while((m=reLatLonBracket.exec(text))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
  reLatLonBracket.lastIndex=0;
  while((m=reLatLonTag.exec(text))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
  reLatLonTag.lastIndex=0;
  while((m=reQuickTime.exec(text))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
  reQuickTime.lastIndex=0;
  while((m=reXmpLatLon.exec(text))){ pushCand(parseFloat(m[1]), parseFloat(m[2])); }
  reXmpLatLon.lastIndex=0;
  // ISO-6709, inside its container only — never loose in the byte stream.
  for(const win of iso6709Windows(text)){
    reISO6709.lastIndex=0;
    while((m=reISO6709.exec(win))){
      const lat=parseFloat(m[1]), lng=parseFloat(m[2]);
      if(!isNaN(lat)&&!isNaN(lng)) pushCand(lat,lng);
    }
  }
  reISO6709.lastIndex=0;

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
      timesSynthesized: false,
    };
  }

  /* One fix is one anchor; several fixes are several anchors, in file order,
     at the coordinates the file gives. Nothing is moved and nothing is added.
     The only invented quantity left is the SPACING when there is more than one
     fix — XMP order is time order but carries no timestamps here — and the
     caller is told so via `timesSynthesized` rather than left to assume. */
  const spread = candidates.length > 1;
  /* `alt` stays undefined when the file did not record one. It used to default
     to 75 m, and that invented number was not cosmetic: the service takes the
     track's median altitude as the flight height, divides it into the sensor
     geometry to get a ground sample distance, and multiplies THAT into every
     hectare the dashboard, the panel and the printed report publish — all
     labelled as if an altitude had been read off the aircraft. An unknown
     altitude makes the area unknown, which the whole stack already renders
     honestly ("no scale recorded"), and an unknown area is a far smaller lie
     than a confidently wrong one. */
  const track: TrackPoint[] = candidates.map((c,i)=> ({
    t: spread ? (i/(candidates.length-1))*SYNTHETIC_SPREAD_S : 0,
    lat: c.lat, lng: c.lng, alt: c.alt,
  }));
  return {
    track,
    found: { lat: candidates[0].lat, lng: candidates[0].lng },
    outsideSurveyArea: false,
    fixes: candidates.length,
    timesSynthesized: spread,
  };
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
