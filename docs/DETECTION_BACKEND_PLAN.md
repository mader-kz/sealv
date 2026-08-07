# Detection Backend — Plan

The counting service that SEALv (the Caspian seal survey platform) calls instead
of `mockDetections()`.

Everything below is grounded in measurements taken on real footage — a 720×1280
drone video and a 1698×1082 aerial still of a Caspian haul-out. Numbers quoted
without a source are ones we took ourselves; see `README.md` for method.

---

## 1. Where we are

**Works, measured:**

| Capability | Evidence |
|---|---|
| CountGD detection | 389 animals, **0 false positives**, 2.1s on a 1698×1082 still |
| Video detection | 656/frame, **0 false positives** on verified-empty water and sand |
| Temporal consensus | 401 confirmed across 4 frames; LocateAnything independently got 403 |
| Frame registration | ORB+RANSAC similarity transform, 89–94% inlier ratios |
| Operator verification | click-to-add/remove, undo, verified totals in export |
| Confidence scores | per detection, from CountGD |

**Exists but is wrong for a service:**

- FastAPI app is a **single-user desktop tool** — sessions in a module-level
  dict, no auth, no tenancy, results keyed by an in-process id.
- Video runs **synchronously**. A 4-frame job is ~2 min, a real sortie is far
  longer. HTTP will time out.
- CountGD runs as **subprocess-per-request** (~0.7s model load each). Fine for
  one image, wasteful across 100 frames.
- Verification edits live **only in browser memory**. A refresh loses them.
- LocateAnything (MLX) is still wired in and only runs on Apple Silicon.

---

## 2. Target architecture

```
SEALv (Next.js)
   │  POST /v1/jobs        ← enqueue, returns job_id
   │  GET  /v1/jobs/{id}   ← poll status
   │  GET  /v1/jobs/{id}/events (SSE)
   ▼
Detection API (FastAPI)
   │  writes job rows
   ▼
Postgres ──── object storage (frames, renders)
   ▲
   │  claims jobs
Worker pool (N processes, model warm in each)
   └── CountGD (torch, CPU or CUDA)
```

**Decisions, and why:**

**CountGD only; drop MLX/LocateAnything from the service.** CountGD beat it on
every measured axis (57% more animals, 0 vs 1 false positive, 32× faster) and it
is plain PyTorch — so it deploys to a Linux/CUDA box unchanged, where MLX
cannot. Keep LocateAnything in the desktop tool for referring-expression
queries; it has no place in the survey pipeline.

**Persistent warm workers, not subprocess-per-call.** 0.7s load is negligible
once but costs ~70s across a 100-frame sortie. Workers hold the model and claim
jobs from a queue.

**Async jobs, always.** Even a single image is ~2s; video is minutes. Every
request enqueues and returns immediately. Progress over SSE, which the desktop
UI already speaks.

**Postgres, not SQLite.** Multi-worker concurrency needs real row locking
(`SELECT … FOR UPDATE SKIP LOCKED` for job claiming).

---

## 3. API contract

This is the part SEALv depends on, so it is the part to agree first.

### `POST /v1/jobs`

```jsonc
{
  "media": {
    "url": "s3://…/DJI_0100.MP4",     // or presigned https
    "kind": "video",                   // video | image
    "width": 1698, "height": 1082
  },
  "survey": {                          // optional but strongly wanted
    "site_id": "kz-north-tyulenii",
    "captured_at": "2026-08-06T07:14:00Z",
    "altitude_m": 120,                 // from DJI SRT
    "gsd_cm_px": 3.1                   // computed if absent, see §5
  },
  "params": {
    "target": "seal",
    "sampling": { "every_s": 1.5, "max_frames": 8 },
    "consensus": { "min_support": 3 },
    "threshold": 0.23,
    "tiling": "auto"                   // auto | off | <px>
  }
}
```

→ `202 { "job_id": "…", "status": "queued" }`

### `GET /v1/jobs/{id}`

```jsonc
{
  "job_id": "…",
  "status": "done",                    // queued|running|done|failed
  "progress": { "frames_done": 8, "frames_total": 8 },
  "result": {
    "count": {
      "best": 576,                     // consensus at min_support
      "low": 401,                      // confirmed in every frame
      "high": 656,                     // seen by any frame at all (low <= best <= high)
      "basis": "consensus_4_frames"     // union_N_frames when min_support is 1
    },
    "per_frame": [
      {"index":0,"t":0.0,"count":656,"registered":true},
      {"index":1,"t":1.5,"count":643,"registered":true}
    ],
    "points": [
      {"x":253.3,"y":272.3,"lat":43.6512,"lng":51.1804,
       "score":0.81,"support":4,"status":"auto"}
    ],
    "quality": {
      "false_positive_risk": "low",
      "tiles_rejected": 0,
      "malformed_dropped": 0,
      "registration": {"1":"affine 1311/1390"}
    },
    "engine": {"name":"countgd","version":"…","threshold":0.23,"tiling":400}
  }
}
```

**Three numbers, not one.** `low`/`best`/`high` is non-negotiable. We measured a
25% spread across four frames 1.5s apart (703/685/580/560 with the old engine;
656/643/570/551 with CountGD) on animals that barely moved. Reporting a single
integer would be false precision, and it is the single most common way a
counting product becomes untrustworthy.

**`status` per point** matches SEALv's existing `auto | validated |
false_positive` so operator edits round-trip without translation.

---

## 4. Data model

```sql
site        (id, name, region, lat, lng)
survey      (id, site_id, captured_at, altitude_m, gsd_cm_px,
             tide_state, sea_ice_pct, operator, notes)
media       (id, survey_id, url, kind, width, height, duration_s)
job         (id, media_id, params jsonb, status, claimed_at, error)
run         (id, job_id, engine, engine_version, params jsonb,
             count_low, count_best, count_high, basis)
point       (id, run_id, frame_idx, x, y, lat, lng, score, support, status)
edit        (id, run_id, op, x, y, point_id, operator, created_at)
```

Two fields carry disproportionate weight:

- **`gsd_cm_px`** — turns pixels into metres. Gives density per km², animal
  size, and lets tiling be chosen automatically (§5).
- **`tide_state` / `sea_ice_pct`** — Caspian seals haul out on winter ice for
  pupping and on land in summer; counts swing enormously with both. A trend line
  built without these will look meaningful and be wrong. Capture them even if
  nothing consumes them yet.

`edit` is an append-only audit log, not a mutation of `point`. Who changed a
count and when is survey evidence.

---

## 5. Auto-configuration from GSD

The one manual knob worth removing. We measured that **target size in pixels**
decides everything:

| Target size | Correct setting | Measured |
|---|---|---|
| ≥40px | whole frame | 389 found, 2.1s |
| ~25px | 250px tiles | 656 vs 525 whole-frame; whole-frame collapsed to 218 on one frame |

An adult Caspian seal is ~1.3m. With GSD from altitude:

```
target_px = 130cm / gsd_cm_px
tile_px   = target_px >= 40 ? 0 (whole frame) : round(target_px * 10)
```

So altitude 120m → GSD ≈3.1 cm/px → target ≈42px → whole frame. Altitude 200m →
GSD ≈5.2 → target ≈25px → 250px tiles. The operator never picks a tile size.

Fall back to the current default when altitude is absent.

---

## 6. Phases

**Phase 1 — service skeleton (2–3 d)**
Postgres schema, job queue with `FOR UPDATE SKIP LOCKED`, `POST /v1/jobs` +
`GET /v1/jobs/{id}`, one warm CountGD worker. Images only. Returns the three-number
count. *Done when SEALv can replace `mockDetections()` for a still.*

**Phase 2 — video + consensus (2–3 d)**
Frame sampling, per-frame detection, affine registration, consensus band, SSE
progress. Port `consensus.py` and `tiling.py` unchanged — both are tested.
*Done when a sortie returns low/best/high.*

**Phase 3 — geo + auto-config (1–2 d)**
Ingest the DJI track (reuse SEALv's SRT parser rather than rewriting it),
pixel→lat/lng per point, GSD auto-tiling. *Done when points land on the map.*

**Phase 4 — verification round-trip (2 d)**
Persist edits to the `edit` log, expose `PATCH /v1/runs/{id}/points`, recompute
verified totals. Wire SEALv's existing bulk-validate UI to it. *Done when a
verified count survives a refresh.*

**Phase 5 — hardening (2–3 d)**
Auth, rate limits, object storage, retries, dead-letter, structured logs,
Docker + CUDA image. Load test with a full sortie.

Roughly **two weeks** to something SEALv can depend on. Phase 1 alone unblocks
their integration.

---

## 7. Risks

**Recall is the real error, and it is unquantified.** Precision is measured at
~0 false positives. Recall is not: on the still we found 389 where inspection
suggests 400+. There is no ground truth anywhere in this work — the 401/403
agreement between two independent models is suggestive, not proof. *Mitigation:
hand-count one image exactly and fix it as a regression baseline. Until then no
accuracy claim should appear in the product UI.*

**Dense overlap is a hard ceiling.** ~90 animals per 250×200px at ~25px each,
physically touching. Our own careful count there is ±6%. No model resolves this;
only flying lower does. *Mitigation: say so in the product, and surface GSD so
operators can see when a sortie was flown too high.*

**Species confusion is untested.** Prompt is `"seal"`. Behaviour on birds,
debris, or people in frame is unknown. *Mitigation: test before release; the
`false_positive` status exists to catch it.*

**CountGD throughput on CPU.** 2.1s/image and ~27s/video-frame on an M3 Max.
A 500-frame sortie is hours. *Mitigation: CUDA deployment, and sample frames
rather than processing all of them — consensus needs ~4–8, not 500.*

**Vendored dependency.** CountGD is pinned to torch 2.2.1 / transformers 4.39.1
and lives in `vendor/`. *Mitigation: it is containerised in Phase 5 and the
pinned stack is frozen there.*

---

## 8. Explicitly out of scope

Model training or fine-tuning, forecasting (SEALv owns it), map rendering,
report generation, and multi-species classification. This service counts one
target class in one piece of media and reports how confident it is.
