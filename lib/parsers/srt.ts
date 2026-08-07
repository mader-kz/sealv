import type { TrackPoint } from "../types";

// DJI SRT formats vary. We support:
// 1) Classic DJI: cue contains GPS( lat, lng, alt, ... ) or [latitude: xx] [longitude: xx] [rel_alt: xx]
// 2) Injected SRT from tools/inject-srt.js: GPS lat lng alt
// 3) Simple injected: "47.123, 51.456, 85.2"

const GPS_REGEXES: RegExp[] = [
  /GPS\s*\(\s*([+-]?\d+\.\d+)\s*,\s*([+-]?\d+\.\d+)\s*(?:,\s*([+-]?\d+\.?\d*))?/i, // GPS(44.123, 50.123, 85)
  /\[latitude:\s*([+-]?\d+\.\d+)\]\s*\[longitude:\s*([+-]?\d+\.\d+)\]/i,
  /latitude:\s*([+-]?\d+\.\d+)[,\s]+longitude:\s*([+-]?\d+\.\d+)/i,
  /([+-]?\d+\.\d+)\s*,\s*([+-]?\d+\.\d+)\s*,?\s*([+-]?\d+\.?\d*)?/, // fallback raw lat,lng
];

function parseLatLng(text: string): { lat: number; lng: number; alt?: number } | null {
  for (const re of GPS_REGEXES) {
    const m = text.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      const alt = m[3] ? parseFloat(m[3]) : undefined;
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        // Caspian roughly 36-48N, 46-55E — but accept generic to be robust; caller can validate
        // heuristic: if lat < 30 and lng > 30, swap? DJI sometimes lat/lng order correct already.
        return { lat, lng, alt };
      }
    }
  }
  return null;
}

function srtTimeToSeconds(time: string): number {
  // 00:00:12,340 -> 12.34 or 00:00:12.340
  const m = time.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

export function parseSRT(content: string): TrackPoint[] {
  const cues = content.split(/\r?\n\r?\n/);
  const track: TrackPoint[] = [];
  let cueIndex = 0;

  for (const cue of cues) {
    const lines = cue.trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    // line0: index, line1: time, rest: text
    let timeLineIdx = 0;
    if (/^\d+$/.test(lines[0].trim())) timeLineIdx = 1;
    const timeLine = lines[timeLineIdx];
    const text = lines.slice(timeLineIdx + 1).join(" ");
    if (!timeLine || !text) continue;
    const timeMatch = timeLine.match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/);
    if (!timeMatch) continue;
    const t = srtTimeToSeconds(timeMatch[1]);
    const parsed = parseLatLng(text);
    if (parsed) {
      track.push({ t, lat: parsed.lat, lng: parsed.lng, alt: parsed.alt, timestamp: timeLine });
    }
    cueIndex++;
    if (cueIndex > 10000) break; // safety
  }

  // deduplicate by t, keep first, sort by t
  track.sort((a, b) => a.t - b.t);
  return track;
}

export function validateTrackInCaspian(track: TrackPoint[]): { valid: boolean; reason?: string } {
  if (track.length === 0) return { valid: false, reason: "No GPS points found in SRT" };
  // Caspian bounds approx: lat 36-48, lng 46-55. Allow 10% margin for test data.
  const caspian = { latMin: 35, latMax: 49, lngMin: 45, lngMax: 56 };
  const inside = track.filter(p => p.lat >= caspian.latMin && p.lat <= caspian.latMax && p.lng >= caspian.lngMin && p.lng <= caspian.lngMax);
  if (inside.length < track.length * 0.3) {
    return { valid: false, reason: `Only ${inside.length}/${track.length} points inside Caspian basin (35-49N,45-56E). Check lat/lng order.` };
  }
  return { valid: true };
}
