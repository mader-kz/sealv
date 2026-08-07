#!/usr/bin/env node
/**
 * inject-srt.js — simulate DJI drone GPS for any MP4 without a drone
 * Usage:
 *   node tools/inject-srt.js input.mp4 --lat 44.85 --lng 50.35 --duration 120
 *   node tools/inject-srt.js --center 44.85,50.35 --out ./test-data --count 3
 *
 * Creates:
 *   input.srt  (DJI-style 1Hz GPS cues)
 *   input.json (sidecar JSON track)
 * If no input given, creates test flights around the Aktau sector — including a
 * real, playable MP4 with the GPS fix written into its metadata (needs ffmpeg),
 * so the "drop a bare MP4 and it finds the location" path can be exercised.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function hasFfmpeg(){
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/** ISO 6709 as ffmpeg/QuickTime write it: +43.6500+051.1800/ */
function iso6709(lat, lng){
  const f = (v, pad) => (v<0?'-':'+') + Math.abs(v).toFixed(4).padStart(pad, '0');
  return `${f(lat,7)}${f(lng,8)}/`;
}

/**
 * Write a real 3-second MP4 carrying the GPS fix in its container metadata.
 * Falls back to an empty placeholder when ffmpeg isn't installed — the sidecar
 * .srt/.json path still works in that case.
 */
function writeVideoWithGPS(outPath, lat, lng, duration){
  const loc = iso6709(lat, lng);
  try {
    if(!hasFfmpeg()) throw new Error('ffmpeg not installed');
    encode(outPath, loc, lat, lng, duration);
    return true;
  } catch (e) {
    console.warn(`  ! could not encode ${path.basename(outPath)}: ${e.message.split('\n')[0]}`);
    if(!fs.existsSync(outPath)) fs.writeFileSync(outPath, Buffer.from([]));
    return false;
  }
}

function encode(outPath, loc, lat, lng, duration){
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    // Plain colour source — no drawtext filter, which many ffmpeg builds omit.
    '-f', 'lavfi', '-i', 'color=c=#0d1b26:s=640x360:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '3',
    '-metadata', `location=${loc}`,
    '-metadata', `location-eng=${loc}`,
    '-metadata', `comment=GPS(${lat.toFixed(6)},${lng.toFixed(6)},75.0) test footage, duration ${duration}s`,
    '-movflags', '+faststart',
    outPath,
  ], { stdio: 'ignore' });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { lat: 44.85, lng: 50.35, duration: 120, out: null, input: null, count: 1, center: null };
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if (a==='--lat') opts.lat=parseFloat(args[++i]);
    else if (a==='--lng') opts.lng=parseFloat(args[++i]);
    else if (a==='--lon') opts.lng=parseFloat(args[++i]);
    else if (a==='--duration') opts.duration=parseInt(args[++i]);
    else if (a==='--out') opts.out=args[++i];
    else if (a==='--count') opts.count=parseInt(args[++i]);
    else if (a==='--center') opts.center=args[++i];
    else if (!a.startsWith('--') && !opts.input) opts.input=a;
    else if (a.startsWith('--help')||a==='-h') { help(); process.exit(0); }
  }
  if (opts.center) {
    const [la,ln]=opts.center.split(',').map(parseFloat);
    if(!isNaN(la)) opts.lat=la; if(!isNaN(ln)) opts.lng=ln;
  }
  return opts;
}
function help(){
  console.log(`Usage:
  node tools/inject-srt.js <video.mp4> --lat 44.85 --lng 50.35 --duration 120
  node tools/inject-srt.js --center 43.65,51.18 --out ./samples --count 3 --duration 90

Creates <video>.srt and <video>.json with 1Hz GPS track simulating DJI SRT.
If no video given, creates demo flights in --out folder.`);
}
function fmtTime(sec){
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60), ms=Math.floor((sec%1)*1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}
function isWaterApprox(lat,lng){
  // same coarse hull as lib/caspian.ts — copy to keep tool standalone
  if(lat<36.5||lat>47.5||lng<46||lng>52.5) return false;
  // Kazakh coast: east of this = land
  if(lat>45.5) { if(lng>51.0) return false; }
  else if(lat>44.5) { if(lng>51.35) return false; }
  else if(lat>43.8) { if(lng>51.25) return false; }
  else if(lat>43.0) { if(lng>51.35) return false; }
  else if(lat>41.5) { if(lng>52.0) return false; }
  else if(lng>51.8) return false;
  return true;
}
function generateTrack(centerLat, centerLng, duration){
  // snap center to water if user gave land
  if(!isWaterApprox(centerLat,centerLng)){
    centerLat -= 0.08; // nudge west into sea
    if(!isWaterApprox(centerLat,centerLng)) centerLat=43.65, centerLng=50.95;
  }
  const pts=[];
  let lat=centerLat, lng=centerLng;
  const seed=Math.random();
  for(let t=0;t<duration;t++){
    let stepLat = Math.sin(t*0.08 + seed*6)*0.006 + (Math.random()-0.5)*0.004;
    let stepLng = Math.cos(t*0.05 + seed*6)*0.007 + (Math.random()-0.5)*0.004;
    let nlat=lat+stepLat, nlng=lng+stepLng;
    if(!isWaterApprox(nlat,nlng)){
      // stay or snap west
      nlat = lat + (centerLat - lat)*0.3;
      nlng = lng + (centerLng - lng)*0.3;
      if(!isWaterApprox(nlat,nlng)){ nlat=centerLat; nlng=centerLng; }
    }
    lat=nlat; lng=nlng;
    const alt = 60 + Math.sin(t*0.12)*15 + Math.random()*10;
    pts.push({ t, lat, lng, alt });
  }
  return pts;
}
function trackToSRT(track){
  let srt='';
  for(let i=0;i<track.length;i++){
    const p=track[i];
    const start=fmtTime(p.t);
    const end=fmtTime(p.t+0.9);
    // DJI-style cue: include both formats for parser robustness
    srt+=`${i+1}\n${start} --> ${end}\nGPS(${p.lat.toFixed(6)},${p.lng.toFixed(6)},${p.alt.toFixed(1)}) [latitude: ${p.lat.toFixed(6)}] [longitude: ${p.lng.toFixed(6)}] [rel_alt: ${p.alt.toFixed(1)}] [alt: ${(p.alt+5).toFixed(1)}]\n\n`;
  }
  return srt;
}
function writeForVideo(videoPath, opts){
  const dir = opts.out || path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const centerLat = opts.lat, centerLng = opts.lng;
  const duration = opts.duration || 120;
  const track = generateTrack(centerLat, centerLng, duration);
  const srt = trackToSRT(track);
  const json = JSON.stringify({ track, meta: { center: {lat:centerLat,lng:centerLng}, duration, generatedAt: new Date().toISOString(), source: "inject-srt.js" } }, null, 2);
  fs.mkdirSync(dir, {recursive:true});
  // if video exists, write beside it; else write demo files
  const srtPath = fs.existsSync(videoPath) ? path.join(path.dirname(videoPath), base+'.srt') : path.join(dir, base+'.srt');
  const jsonPath = fs.existsSync(videoPath) ? path.join(path.dirname(videoPath), base+'.json') : path.join(dir, base+'.json');
  fs.writeFileSync(srtPath, srt);
  fs.writeFileSync(jsonPath, json);
  console.log(`✓ ${path.basename(srtPath)} (${track.length} cues, ${centerLat.toFixed(4)},${centerLng.toFixed(4)}, ${duration}s)`);
  console.log(`✓ ${path.basename(jsonPath)}`);
}

(function main(){
  const opts=parseArgs();
  if (opts.input && fs.existsSync(opts.input)) {
    // single video mode (even if dummy empty file)
    writeForVideo(opts.input, opts);
  } else if (opts.input && !fs.existsSync(opts.input)) {
    // create placeholder video arg as base name even if file missing
    console.log(`Note: input ${opts.input} not found — creating sidecars as if it existed.`);
    writeForVideo(opts.input, opts);
  } else {
    // demo mode: create count flights
    const out = opts.out || './samples';
    const centers = [
      [44.85, 50.35, "Tyuleniy-W"],
      [43.20, 51.80, "Kendirli"],
      [43.65, 51.18, "Aktau"],
      [44.55, 50.22, "Bautino"],
      [45.35, 50.75, "Durneva"],
    ];
    for(let i=0;i<opts.count;i++){
      const c = centers[i % centers.length];
      const lat = c[0] + (Math.random()-0.5)*0.15;
      const lng = c[1] + (Math.random()-0.5)*0.15;
      const base = `TEST_${String(100+i).padStart(4,'0')}.MP4`;
      const videoPath = path.join(out, base);
      fs.mkdirSync(out, { recursive: true });
      const real = writeVideoWithGPS(videoPath, lat, lng, opts.duration || 120);
      console.log(`✓ ${base} ${real ? '(playable, GPS in metadata)' : '(empty placeholder — install ffmpeg for a real one)'}`);
      writeForVideo(videoPath, { ...opts, lat, lng });
    }
    console.log(`\n${opts.count} test flight(s) in ${out}/`);
    console.log(`Drop the .MP4 on its own to test location-from-video, or the .MP4 + .SRT together to test the sidecar path.`);
  }
})();
