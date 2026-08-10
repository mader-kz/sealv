"""Pollution API — encapsulated router, additive only."""
from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse

from service.pollution import db as pol_db
from service.pollution.opencode_geocoder import validate_root_cause
from service.pollution.registry import REGISTRY, discover_pollers
from service.pollution.scheduler import cadence_seconds, get_scheduler

discover_pollers()

# Reuse existing DB helper — same SQLite file
try:
    from service.db import connect as _connect  # type: ignore
except Exception:
    from db import connect as _connect  # type: ignore

router = APIRouter(prefix="/v1/pollution", tags=["pollution"])
_KINDS = ("flare", "slick", "spill", "discharge")


def _raw_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first_text(raw: dict[str, Any], *keys: str) -> Optional[str]:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:500]
    return None


def _safe_http_url(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    parsed = urlparse(candidate)
    return candidate if parsed.scheme in {"http", "https"} and bool(parsed.netloc) else None


def _safe_geometry(value: Any) -> Optional[dict[str, Any]]:
    """Accept only valid, closed GeoJSON polygons; unsafe geometry falls back to its point."""
    if not isinstance(value, dict) or value.get("type") != "Polygon":
        return None
    coordinates = value.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        return None
    for ring in coordinates:
        if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
            return None
        for position in ring:
            if not isinstance(position, list) or len(position) < 2:
                return None
            lng, lat = position[0], position[1]
            if (
                not isinstance(lng, (int, float))
                or isinstance(lng, bool)
                or not isinstance(lat, (int, float))
                or isinstance(lat, bool)
                or not math.isfinite(float(lng))
                or not math.isfinite(float(lat))
                or not (-180 <= float(lng) <= 180)
                or not (-90 <= float(lat) <= 90)
            ):
                return None
    return {"type": "Polygon", "coordinates": coordinates}


def _incident_feature(
    row: dict[str, Any],
    source_names: dict[str, str],
    source_urls: dict[str, Optional[str]],
) -> Optional[dict[str, Any]]:
    lat, lng = row.get("lat"), row.get("lng")
    if (
        not isinstance(lat, (int, float))
        or not isinstance(lng, (int, float))
        or isinstance(lat, bool)
        or isinstance(lng, bool)
        or not math.isfinite(float(lat))
        or not math.isfinite(float(lng))
        or not (-90 <= float(lat) <= 90)
        or not (-180 <= float(lng) <= 180)
    ):
        return None
    raw = _raw_dict(row.get("raw"))
    source_id = str(row["source_id"])
    geometry = _safe_geometry(row.get("geom")) or {
        "type": "Point",
        "coordinates": [float(lng), float(lat)],
    }
    title = _first_text(raw, "title", "name", "text", "description", "row")
    link = None
    for key in ("link", "url", "source_url", "href", "doc_url"):
        link = _safe_http_url(raw.get(key))
        if link:
            break
    raw_status = _first_text(raw, "verification_status", "status")
    properties = {
        "id": str(row["id"]),
        "source_id": source_id,
        "source_name": source_names.get(source_id, source_id),
        "source_url": source_urls.get(source_id),
        "source_link": link,
        "title": title or "Untitled source record",
        "root_cause": validate_root_cause(raw.get("root_cause")),
        "status": raw_status or "source_record",
        "observed_at": row.get("observed_at"),
        "lat": float(lat),
        "lng": float(lng),
        "radius_m": row.get("radius_m"),
        "radius_meaning": "location_uncertainty",
        "kind": row.get("kind"),
        "area_km2": row.get("area_km2"),
        "confidence": row.get("confidence"),
        "location_precision": row.get("location_precision"),
        "raw": raw,
    }
    if "seq" in row:
        properties["change_seq"] = int(row["seq"])
        properties["change_action"] = str(row.get("action") or "updated")
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def _conn() -> sqlite3.Connection:
    return _connect()

def _source_status_rows() -> list[dict[str, Any]]:
    conn = _conn()
    try:
        for source in REGISTRY.values():
            pol_db.upsert_source(conn, source)
            pol_db.ensure_source_health(conn, source.id)
        rows = pol_db.list_source_health(conn)
    finally:
        conn.close()
    for row in rows:
        source = REGISTRY.get(str(row["id"]))
        row.pop("lease_owner", None)
        row["poller_registered"] = bool(source and source.poller)
        last_success_raw = row.get("last_success_at")
        try:
            last_success = datetime.fromisoformat(
                str(last_success_raw).replace("Z", "+00:00")
            ) if last_success_raw else None
        except ValueError:
            last_success = None
        stale_after = max(
            6 * 3600,
            2 * cadence_seconds(source.update_freq if source else "", 3600),
        )
        row["stale"] = (
            last_success is None
            or (datetime.now(timezone.utc) - last_success).total_seconds() > stale_after
        )
    return rows

def _parse_bbox(value: Optional[str]) -> tuple[float, float, float, float] | None:
    if not value:
        return None
    try:
        parts = [float(item.strip()) for item in value.split(",")]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="bbox must be west,south,east,north") from exc
    if len(parts) != 4 or not all(math.isfinite(item) for item in parts):
        raise HTTPException(status_code=422, detail="bbox must contain four finite numbers")
    west, south, east, north = parts
    if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
        raise HTTPException(status_code=422, detail="bbox is outside valid coordinate bounds")
    return west, south, east, north




@router.get("/sources")
def list_sources():
    """List source metadata enriched with persisted scheduler health."""
    return {"sources": _source_status_rows()}


@router.get("")
def list_incidents(
    bbox: Optional[str] = Query(None, description="west,south,east,north"),
    since: Optional[str] = Query(None, description="ISO8601 since"),
    kind: Optional[str] = Query(None),
    limit: int = Query(500, ge=1, le=2000),
):
    parsed_bbox = _parse_bbox(bbox)

    conn = _conn()
    try:
        conn.execute("BEGIN")
        rows = pol_db.list_incidents(conn, bbox=parsed_bbox, since=since, kind=kind, limit=limit)
        cursor = 0 if len(rows) == limit else pol_db.latest_change_seq(conn)
        source_names = {source.id: source.name for source in REGISTRY.values()}
        source_urls = {source.id: _safe_http_url(source.url) for source in REGISTRY.values()}
        features = []
        for row in rows:
            feature = _incident_feature(row, source_names, source_urls)
            if feature is not None:
                features.append(feature)
        payload = {
            "type": "FeatureCollection",
            "features": features,
            "count": len(features),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "cursor": cursor,
        }
        conn.execute("COMMIT")
        return payload
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


@router.get("/changes")
def pollution_changes(
    after: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
    bbox: Optional[str] = Query(None, description="west,south,east,north"),
):
    """Return ordered incident inserts and updates after a durable cursor."""
    conn = _conn()
    parsed_bbox = _parse_bbox(bbox)
    try:
        rows = pol_db.list_changes(conn, after=after, limit=limit)
        source_names = {source.id: source.name for source in REGISTRY.values()}
        source_urls = {source.id: _safe_http_url(source.url) for source in REGISTRY.values()}
        features = []
        removed: list[str] = []
        for row in rows:
            if parsed_bbox is not None:
                west, south, east, north = parsed_bbox
                if not (west <= row["lng"] <= east and south <= row["lat"] <= north):
                    removed.append(str(row["id"]))
                    continue
            feature = _incident_feature(row, source_names, source_urls)
            if feature is not None:
                features.append(feature)
        next_cursor = int(rows[-1]["seq"]) if rows else after
        return {
            "type": "FeatureCollection",
            "features": features,
            "removed": list(dict.fromkeys(removed)),
            "count": len(features),
            "cursor": next_cursor,
            "has_more": len(rows) == limit,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        conn.close()



@router.get("/status")
def pollution_status():
    """Return scheduler state and persisted outcomes for every source."""
    rows = _source_status_rows()
    statuses: dict[str, int] = {}
    for row in rows:
        status = str(row.get("status") or "never")
        statuses[status] = statuses.get(status, 0) + 1
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "scheduler": get_scheduler().state(),
        "summary": {
            "sources": len(rows),
            "statuses": statuses,
            "attempts": sum(int(row.get("attempts") or 0) for row in rows),
            "successes": sum(int(row.get("successes") or 0) for row in rows),
            "items": sum(int(row.get("total_items") or 0) for row in rows),
            "inserted": sum(int(row.get("total_inserted") or 0) for row in rows),
            "updated": sum(int(row.get("total_updated") or 0) for row in rows),
            "unchanged": sum(int(row.get("total_unchanged") or 0) for row in rows),
            "stale": sum(1 for row in rows if row.get("stale")),
        },
        "sources": rows,
    }


@router.get("/health")
def health():
    """Report observable local evidence without claiming upstream availability."""
    checked_at = datetime.now(timezone.utc).isoformat()
    try:
        conn = _conn()
        try:
            for source in REGISTRY.values():
                pol_db.upsert_source(conn, source)
            conn.commit()
            rows = conn.execute(
                """SELECT source_id, COUNT(*) AS incident_count,
                          MAX(observed_at) AS latest_observed_at
                   FROM pollution_incident GROUP BY source_id"""
            ).fetchall()
            evidence = {
                str(row["source_id"]): {
                    "incident_count": int(row["incident_count"]),
                    "latest_observed_at": row["latest_observed_at"],
                }
                for row in rows
            }
            total = pol_db.count_incidents(conn)
        finally:
            conn.close()
        sources = []
        for source in sorted(REGISTRY.values(), key=lambda item: item.name.lower()):
            observed = evidence.get(source.id, {"incident_count": 0, "latest_observed_at": None})
            has_records = observed["incident_count"] > 0
            sources.append({
                "id": source.id,
                "name": source.name,
                "url": _safe_http_url(source.url),
                "poller_registered": bool(source.poller),
                "status": "records_available" if has_records else "configured_no_records",
                "incident_count": observed["incident_count"],
                "latest_observed_at": observed["latest_observed_at"],
                "evidence": (
                    "Local source records are available"
                    if has_records
                    else "Source is configured; no local records"
                ),
            })
        return {
            "ok": True,
            "checked_at": checked_at,
            "database_readable": True,
            "incidents": total,
            "sources": len(sources),
            "source_health": sources,
            "meaning": "Health is local ingestion evidence, not an upstream uptime guarantee.",
        }
    except Exception as exc:
        return {
            "ok": False,
            "checked_at": checked_at,
            "database_readable": False,
            "error": str(exc),
            "source_health": [],
        }


@router.get("/map", response_class=HTMLResponse)
def pollution_map():
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SEALv Caspian Pollution Evidence Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    :root{color-scheme:dark;--ink:#edf4f6;--ink-soft:#b9c9ce;--muted:#8fa4ac;--panel:#10181de8;--surface:#0a1317;--surface-raised:#10181d;--badge:#27353b;--line:#29404a;--bg:#071014;--accent:#77d6bc;--accent-soft:#77d6bc20;--danger:#ff5c57;--danger-soft:#ff5c5720;--caution:#f1c46b;--caution-soft:#f1c46b12;--caution-text:#dfcb9f;--uncertainty:#d9ecf2;--kind-flare:#ffb02e;--kind-slick:#d968e8;--kind-slick-soft:#d968e833;--kind-spill:#ff5c57;--kind-discharge:#45c7dc;--age-day:#f04e45;--age-week:#e96b3c;--age-month:#dc8733;--age-quarter:#c6a044;--age-old:#748896;--age-unknown:#87939a;--shadow:#0009}
    *{box-sizing:border-box}html,body,#map{height:100%;margin:0}body{background:var(--bg);font:13px/1.4 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink)}
    #map{background:var(--bg)}.leaflet-control-zoom a{background:var(--surface-raised);color:var(--ink);border-color:var(--line)}.leaflet-popup-content-wrapper,.leaflet-popup-tip{background:var(--surface-raised);color:var(--ink)}
    .panel{position:absolute;z-index:1000;top:12px;left:12px;width:min(372px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 14px 48px var(--shadow);backdrop-filter:blur(14px)}
    header{padding:15px 16px 12px;border-bottom:1px solid var(--line)}h1{font-size:16px;line-height:1.2;margin:0 0 5px;letter-spacing:.01em}.eyebrow{color:var(--accent);text-transform:uppercase;letter-spacing:.12em;font-size:10px;font-weight:700}.sub{color:var(--muted);font-size:11px}
    section{padding:12px 16px;border-bottom:1px solid var(--line)}section:last-child{border:0}.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-soft)}.section-title-spaced{margin-top:12px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field label{display:block;color:var(--muted);font-size:10px;margin:0 0 4px}.field select{width:100%;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--ink);padding:7px 8px;font:inherit}.field select:focus-visible,.kind-toggle:focus-within,.popup a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .kinds{display:grid;grid-template-columns:1fr 1fr;gap:6px}.kind-toggle{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:7px;padding:6px 8px;background:var(--surface)}.kind-toggle input{accent-color:var(--accent)}.swatch{width:9px;height:9px;border-radius:50%;flex:none}.flare{background:var(--kind-flare)}.slick{background:var(--kind-slick)}.spill{background:var(--kind-spill)}.discharge{background:var(--kind-discharge)}
    .statusline{display:flex;gap:8px;align-items:center}.pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}.statusline.error .pulse{background:var(--danger);box-shadow:0 0 0 4px var(--danger-soft)}#data-status{font-size:12px}.timestamp{font-size:10px;color:var(--muted);margin-top:3px}
    #health-list{display:grid;gap:6px}.health-row{display:grid;grid-template-columns:9px 1fr auto;gap:7px;align-items:start;padding:7px 8px;border-radius:7px;background:var(--surface)}.health-dot{width:7px;height:7px;border-radius:50%;margin-top:5px;background:var(--muted)}.health-dot.records{background:var(--accent)}.health-name{font-size:11px;font-weight:650}.health-evidence{font-size:10px;color:var(--muted)}.health-count{font-variant-numeric:tabular-nums;color:var(--ink-soft);font-size:10px}
    .legend{display:grid;gap:6px;color:var(--ink-soft);font-size:10px}.legend-group{display:grid;grid-template-columns:1fr 1fr;gap:5px 8px}.legend-row{display:flex;gap:7px;align-items:center;min-width:0}.age-key{width:18px;height:18px;border:2px solid var(--bg);border-radius:50%;flex:none}.age-day{background:var(--age-day);opacity:.86}.age-week{background:var(--age-week);opacity:.72}.age-month{background:var(--age-month);opacity:.58}.age-quarter{background:var(--age-quarter);opacity:.44}.age-old{background:var(--age-old);opacity:.28}.age-unknown{background:var(--age-unknown);opacity:.38}.dash{width:20px;height:10px;border:1px dashed var(--uncertainty);border-radius:50%;flex:none}.polygon{width:20px;height:10px;border:1px solid var(--kind-slick);background:var(--kind-slick-soft);flex:none}.warning{margin-top:8px;padding:7px 8px;border-left:2px solid var(--caution);background:var(--caution-soft);color:var(--caution-text);font-size:10px}
    .popup{max-width:320px}.popup-head{display:flex;gap:7px;align-items:center;margin-bottom:8px}.kind-badge{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;padding:2px 5px;border-radius:4px;background:var(--badge)}.popup-root-cause{font-size:16px;font-weight:700;line-height:1.35;margin:0 0 8px;color:var(--ink)}.popup-evidence{font-size:12px;line-height:1.4;margin:0 0 10px;color:var(--ink-soft)}.popup-evidence-label{display:block;margin-bottom:2px;color:var(--muted);font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.popup-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 8px;font-size:10px}.popup-grid dt{color:var(--muted)}.popup-grid dd{margin:0}.popup a{display:inline-block;margin-top:10px;color:var(--accent);font-size:11px;text-decoration:underline;text-underline-offset:2px}.uncertainty{color:var(--caution)}
    .leaflet-interactive:focus{outline:3px solid var(--ink);outline-offset:2px}
    @media(max-width:680px){.panel{top:8px;left:8px;max-height:52vh;width:calc(100vw - 16px)}.leaflet-control-zoom{display:none}.popup-root-cause{font-size:15px}}
  </style>
</head>
<body>
  <div id="map" role="region" aria-label="Interactive Caspian pollution evidence map"></div>
  <aside class="panel" aria-label="Pollution map controls and source health">
    <header>
      <div class="eyebrow">Caspian source monitor</div>
      <h1>Pollution evidence map</h1>
      <div class="sub">Source-reported and remotely derived records. Symbols are evidence, not confirmed spill boundaries.</div>
    </header>
    <section>
      <div class="section-title"><span>Filters</span><span id="visible-count">—</span></div>
      <div class="grid">
        <div class="field"><label for="source-filter">Source</label><select id="source-filter"><option value="">All sources</option></select></div>
        <div class="field"><label for="date-filter">Observed</label><select id="date-filter"><option value="6m">Past six months</option><option value="30d">Past 30 days</option><option value="all">All local records</option></select></div>
        <div class="field"><label for="confidence-filter">Minimum confidence</label><select id="confidence-filter"><option value="0">Any / not supplied</option><option value=".5">50%</option><option value=".75">75%</option><option value=".9">90%</option></select></div>
      </div>
      <div class="section-title section-title-spaced"><span>Evidence kind</span></div>
      <div class="kinds">
        <label class="kind-toggle"><input type="checkbox" value="flare" checked><span class="swatch flare" aria-hidden="true"></span>Flare</label>
        <label class="kind-toggle"><input type="checkbox" value="slick" checked><span class="swatch slick" aria-hidden="true"></span>Slick</label>
        <label class="kind-toggle"><input type="checkbox" value="spill" checked><span class="swatch spill" aria-hidden="true"></span>Spill report</label>
        <label class="kind-toggle"><input type="checkbox" value="discharge" checked><span class="swatch discharge" aria-hidden="true"></span>Discharge</label>
      </div>
    </section>
    <section>
      <div class="statusline" id="status-wrap"><span class="pulse"></span><div><div id="data-status">Loading local evidence…</div><div class="timestamp" id="generated-at"></div></div></div>
    </section>
    <section>
      <div class="section-title"><span>Source health evidence</span><span id="health-total">—</span></div>
      <div id="health-list"><div class="health-evidence">Loading source registry…</div></div>
      <div class="warning">Health shows configured pollers and local records. It does not claim that an upstream site is currently available.</div>
    </section>
    <section aria-labelledby="map-meaning-title">
      <div class="section-title" id="map-meaning-title"><span>Map meaning</span></div>
      <div class="legend">
        <div class="legend-group" role="group" aria-label="Incident age colors">
          <div class="legend-row"><span class="age-key age-day" aria-hidden="true"></span>0–24 hours</div>
          <div class="legend-row"><span class="age-key age-week" aria-hidden="true"></span>1–7 days</div>
          <div class="legend-row"><span class="age-key age-month" aria-hidden="true"></span>7–30 days</div>
          <div class="legend-row"><span class="age-key age-quarter" aria-hidden="true"></span>30–90 days</div>
          <div class="legend-row"><span class="age-key age-old" aria-hidden="true"></span>Older than 90 days</div>
          <div class="legend-row"><span class="age-key age-unknown" aria-hidden="true"></span>Date unknown</div>
        </div>
        <div class="legend-row"><span class="dash" aria-hidden="true"></span>Dashed outline = reported location uncertainty radius</div>
        <div class="legend-row"><span class="polygon" aria-hidden="true"></span>Filled outline = analyst/derived mapped slick geometry</div>
      </div>
      <div class="warning">Marker size is for visibility only. A radius is never a spill area. NASA FIRMS detections are shown only as <b>flare</b>, never as oil.</div>
    </section>
  </aside>
  <script>
    const cssValue=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const ageStyles=[
      {maxDays:1,color:cssValue('--age-day'),opacity:.86,label:'within 24 hours'},
      {maxDays:7,color:cssValue('--age-week'),opacity:.72,label:'1 to 7 days old'},
      {maxDays:30,color:cssValue('--age-month'),opacity:.58,label:'7 to 30 days old'},
      {maxDays:90,color:cssValue('--age-quarter'),opacity:.44,label:'30 to 90 days old'},
      {maxDays:Infinity,color:cssValue('--age-old'),opacity:.28,label:'more than 90 days old'}
    ];
    const unknownAgeStyle={color:cssValue('--age-unknown'),opacity:.38,label:'date unknown'};
    const labels={flare:'Flare',slick:'Slick',spill:'Spill report',discharge:'Discharge'};
    const map=L.map('map',{zoomControl:true}).setView([42.4,50.7],6);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{attribution:'© CARTO © OpenStreetMap',maxZoom:18}).addTo(map);
    const evidenceLayer=L.layerGroup().addTo(map);
    let collection={type:'FeatureCollection',features:[]};
    let evidenceReferenceTime=Date.now();

    const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const fmtDate=value=>{
      if(!value)return 'Not supplied';
      const date=new Date(value);
      return Number.isNaN(date.getTime())?String(value):date.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    };
    const observedTime=value=>{
      if(typeof value!=='string'||!value.trim())return null;
      const text=value.trim();
      const normalized=/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?$/.test(text)?text+'Z':text;
      const timestamp=Date.parse(normalized);
      return Number.isFinite(timestamp)?timestamp:null;
    };
    const ageStyle=(value,referenceTime)=>{
      const observed=observedTime(value);
      if(observed===null||observed>referenceTime)return unknownAgeStyle;
      const ageDays=(referenceTime-observed)/86400000;
      return ageStyles.find(style=>ageDays<=style.maxDays)||ageStyles[ageStyles.length-1];
    };
    const fmtRadius=value=>{
      const radius=Number(value);
      if(!Number.isFinite(radius))return 'Not supplied';
      return radius>=1000?(radius/1000).toFixed(radius>=10000?0:1)+' km':Math.round(radius)+' m';
    };
    const cutoff=mode=>{
      if(mode==='all')return null;
      const date=new Date();
      if(mode==='30d')date.setUTCDate(date.getUTCDate()-30);else date.setUTCMonth(date.getUTCMonth()-6);
      return date.toISOString();
    };
    const statusLabel=value=>value==='source_record'?'Source record · not independently verified':String(value||'Not supplied').replaceAll('_',' ');
    const sourceOption=(id,name)=>{
      const option=document.createElement('option');option.value=id;option.textContent=name;return option;
    };

    function popupHtml(feature){
      const p=feature.properties;
      const confidence=p.confidence!=null&&Number.isFinite(Number(p.confidence))?Math.round(Number(p.confidence)*100)+'%':'Not supplied';
      const area=p.area_km2!=null?`<dt>Mapped geometry</dt><dd>${esc(p.area_km2)} km² (derived/analyst)</dd>`:'';
      const link=p.source_link?`<a href="${esc(p.source_link)}" target="_blank" rel="noopener noreferrer" aria-label="Open original evidence source in a new tab">Open original source ↗</a>`:'';
      const rootCause=typeof p.root_cause==='string'&&p.root_cause.trim()?p.root_cause.trim():'Cause not yet determined.';
      const evidenceTitle=typeof p.title==='string'&&p.title.trim()?p.title.trim():'Untitled source record';
      return `<div class="popup"><div class="popup-root-cause">${esc(rootCause)}</div>
        <div class="popup-head"><span class="swatch ${esc(p.kind)}" aria-hidden="true"></span><b>${esc(labels[p.kind]||p.kind||'Record')}</b></div>
        <div class="popup-evidence"><span class="popup-evidence-label">Evidence title</span>${esc(evidenceTitle)}</div>
        <dl class="popup-grid">
          <dt>Source</dt><dd>${esc(p.source_name||p.source_id||'Not supplied')}</dd>
          <dt>Date</dt><dd>${esc(fmtDate(p.observed_at))}</dd>
          <dt>Kind</dt><dd>${esc(labels[p.kind]||p.kind||'Not supplied')}</dd>
          <dt>Precision</dt><dd>${esc(p.location_precision||'Not supplied')}</dd>
          <dt class="uncertainty">Uncertainty</dt><dd class="uncertainty">${esc(fmtRadius(p.radius_m))} radius · not spill area</dd>
          <dt>Coordinates</dt><dd>${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}</dd>
          <dt>Confidence</dt><dd>${esc(confidence)}</dd>
          <dt>Status</dt><dd>${esc(statusLabel(p.status))}</dd>${area}
        </dl>${link}</div>`;
    }

    function render(){
      evidenceLayer.clearLayers();
      const selectedSource=document.getElementById('source-filter').value;
      const minConfidence=Number(document.getElementById('confidence-filter').value);
      const enabled=new Set([...document.querySelectorAll('.kind-toggle input:checked')].map(input=>input.value));
      const visible=collection.features.filter(feature=>{
        const p=feature.properties;
        if(selectedSource&&p.source_id!==selectedSource)return false;
        if(!enabled.has(p.kind))return false;
        if(minConfidence>0&&(!Number.isFinite(Number(p.confidence))||Number(p.confidence)<minConfidence))return false;
        return true;
      });
      const referenceTime=evidenceReferenceTime;
      visible.forEach(feature=>{
        const p=feature.properties,ll=[Number(p.lat),Number(p.lng)],temporal=ageStyle(p.observed_at,referenceTime);
        if(feature.geometry&&feature.geometry.type==='Polygon'){
          L.geoJSON(feature.geometry,{style:{color:temporal.color,weight:2,opacity:temporal.opacity,fillColor:temporal.color,fillOpacity:temporal.opacity*.25}}).addTo(evidenceLayer).bindPopup(popupHtml(feature));
        }
        const uncertainty=Number(p.radius_m);
        if(Number.isFinite(uncertainty)&&uncertainty>0){
          L.circle(ll,{radius:uncertainty,color:cssValue('--uncertainty'),weight:1,dashArray:'5 5',opacity:.55,fill:false,interactive:false}).addTo(evidenceLayer);
        }
        L.circleMarker(ll,{radius:15,stroke:false,fillColor:temporal.color,fillOpacity:temporal.opacity*.22,interactive:false}).addTo(evidenceLayer);
        const marker=L.circleMarker(ll,{radius:10,color:cssValue('--bg'),weight:2,opacity:.9,fillColor:temporal.color,fillOpacity:temporal.opacity}).addTo(evidenceLayer).bindPopup(popupHtml(feature));
        const cause=typeof p.root_cause==='string'&&p.root_cause.trim()?p.root_cause.trim():'Cause not yet determined';
        const markerLabel=`${labels[p.kind]||p.kind||'Pollution'}; ${temporal.label}; ${cause}`;
        const element=marker.getElement();
        if(element){
          element.setAttribute('role','button');
          element.setAttribute('tabindex','0');
          element.setAttribute('aria-label',markerLabel);
          element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();marker.openPopup();}});
        }
      });
      document.getElementById('visible-count').textContent=`${visible.length} / ${collection.features.length}`;
      if(visible.length){
        const bounds=L.latLngBounds(visible.map(item=>[item.properties.lat,item.properties.lng]));
        if(bounds.isValid())map.fitBounds(bounds,{padding:[36,36],maxZoom:11});
      }
    }

    async function loadEvidence(){
      const mode=document.getElementById('date-filter').value;
      const since=cutoff(mode);
      const params=new URLSearchParams({bbox:'46,36,55,48',limit:'2000'});
      if(since)params.set('since',since);
      const response=await fetch('/v1/pollution?'+params);
      if(!response.ok)throw new Error('Evidence API '+response.status);
      collection=await response.json();
      evidenceReferenceTime=observedTime(collection.generated_at)??Date.now();
      const sourceSelect=document.getElementById('source-filter');
      const current=sourceSelect.value;
      const known=new Map(collection.features.map(item=>[item.properties.source_id,item.properties.source_name||item.properties.source_id]));
      sourceSelect.replaceChildren(sourceOption('','All sources'),...[...known].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>sourceOption(id,name)));
      sourceSelect.value=known.has(current)?current:'';
      document.getElementById('data-status').textContent=`Loaded ${collection.features.length} source records`;
      document.getElementById('generated-at').textContent='API generated '+fmtDate(collection.generated_at);
      document.getElementById('status-wrap').classList.remove('error');
      render();
    }

    async function loadHealth(){
      const response=await fetch('/v1/pollution/health');
      if(!response.ok)throw new Error('Health API '+response.status);
      const health=await response.json();
      if(!health.ok)throw new Error(health.error||'Health unavailable');
      document.getElementById('health-total').textContent=`${health.incidents} records`;
      const list=document.getElementById('health-list');list.replaceChildren();
      health.source_health.forEach(source=>{
        const row=document.createElement('div');row.className='health-row';
        const dot=document.createElement('span');dot.className='health-dot'+(source.incident_count?' records':'');
        const detail=document.createElement('div');
        const name=document.createElement('div');name.className='health-name';name.textContent=source.name;
        const evidence=document.createElement('div');evidence.className='health-evidence';
        evidence.textContent=source.incident_count?`Latest local record: ${fmtDate(source.latest_observed_at)}`:'Configured poller · no local records';
        detail.append(name,evidence);
        const count=document.createElement('span');count.className='health-count';count.textContent=String(source.incident_count);
        row.append(dot,detail,count);list.append(row);
      });
    }

    document.getElementById('date-filter').addEventListener('change',()=>loadEvidence().catch(showError));
    document.getElementById('source-filter').addEventListener('change',render);
    document.getElementById('confidence-filter').addEventListener('change',render);
    document.querySelectorAll('.kind-toggle input').forEach(input=>input.addEventListener('change',render));
    function showError(error){
      document.getElementById('status-wrap').classList.add('error');
      document.getElementById('data-status').textContent=error.message||String(error);
    }
    Promise.all([loadEvidence(),loadHealth()]).catch(showError);
  </script>
</body>
</html>"""
