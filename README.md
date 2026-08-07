# SEALv

Aerial survey counting for Caspian seals. Drop in a drone still or a video and
get back a count you can defend: a **low / best / high band**, every detection
placed on the frame for an operator to correct, and a record of which weights
produced it.

![detector](https://img.shields.io/badge/detector-CountGD-black)
![inference](https://img.shields.io/badge/inference-Modal%20T4%20%C2%B7%20scale--to--zero-black)
![ui](https://img.shields.io/badge/ui-en%20%C2%B7%20ru%20%C2%B7%20kk-black)

## What it does

- **Counts dense colonies.** 389 animals on the reference aerial still, whole
  frame, no tiling, **0 false positives** on hand-verified empty ground.
- **Reports a band, never a bare integer.** Dense overlapping animals have no
  single true count that a person could reproduce, so the answer is
  `low ≤ best ≤ high` with the basis recorded alongside it.
- **Tiles by ground sample distance, not by guesswork.** Altitude and sensor
  optics give cm/pixel; tile size follows from target size. Whole-frame above
  40 px targets, tiled below.
- **Survives drone drift.** Multi-frame runs are registered with ORB + RANSAC
  affine before detections are clustered across frames.
- **Puts a human in the loop.** Verify mode lets an operator add, delete and
  confirm points; every edit is written to an append-only audit log.
- **Georeferences.** DJI SRT and EXIF are parsed into per-point lat/lng.
- **Speaks three languages.** English, Russian and Kazakh, checked for parity
  in CI.

What it does **not** claim is recall. Precision was verified by rendering every
detection over hand-checked ground; how many animals were *missed* is unmeasured
because there is no ground-truth count for these frames. See
[Getting to an exact count](#getting-to-an-exact-count).

## Run it

**Deployed** — the service runs on Railway with inference offloaded to a GPU on
Modal that scales to zero between sorties. Setup in [docs/CI.md](docs/CI.md),
[docs/DEPLOY.md](docs/DEPLOY.md) and [docs/DEPLOY_MODAL.md](docs/DEPLOY_MODAL.md).
Push a tag and CI deploys it.

**Locally**, in a container:

```bash
docker build -t sealv .
docker run -p 8090:8090 -v sealv-data:/data sealv
```

The UI is at <http://127.0.0.1:8090>. Weights are baked in at build time, so the
container runs with no network. Set `SEALV_MODAL_APP` plus the two Modal token
variables to offload inference to a GPU instead of running it on CPU.

## What's in here

`service/` is the API, database and worker; `webapp/` is the operator UI;
`la_studio/` is the detection engine plus the MLX prototype this grew out of;
`modal_app.py` is the GPU side; `vendor/CountGD/` is the vendored detector.

### The web platform lives on `old-codebase`

This branch is the detection half. The Next.js platform — Caspian chart on
MapLibre, sortie ingest, analytics, forecasting and reporting — is on the
[`old-codebase`](../../tree/old-codebase) branch, with its own README.

The two halves fit together: the platform reads flight tracks and plots
observations but its detections are synthetic (`lib/mock/detections.ts`), and
this branch is the real counting engine that fills exactly that gap.

---

# The MLX prototype

Everything below is the working notes from the prototype that preceded the
service above — a local Apple Silicon app for NVIDIA's **LocateAnything-3B**,
launched with `./run.sh`. It is kept because the measurements in it are what
chose the detector, and because open-vocabulary grounding still does one thing
CountGD cannot: find things nobody trained a counter for.

It is **not** what the deployed service runs. That is CountGD — see
[Which engine to use](#which-engine-to-use--countgd-measured).

## Requirements

- Apple Silicon Mac (M-series). The 4-bit build needs ~4 GB of RAM at runtime.
- `ffmpeg` on PATH — `brew install ffmpeg`
- [`uv`](https://docs.astral.sh/uv/) — `brew install uv`

## Run

```bash
./run.sh
```

First launch creates a venv, installs dependencies and pulls ~3 GB of weights, so
it takes a few minutes. After that the model loads from cache in seconds. The UI
is at <http://127.0.0.1:8077>.

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8077` | HTTP port |
| `LA_MODEL` | `mlx-community/LocateAnything-3B-8bit` | `-4bit` is 1.2 GB smaller but measurably worse — see below |

### 4-bit vs 8-bit — measured, not assumed

Same two frames of aerial seal-colony footage, identical settings (180px tiles,
point mode, 4096 tokens, temp 0):

| Frame | Model | Points | Malformed blocks | Tiles rejected | Time |
|---|---|---|---|---|---|
| A | 4-bit | 625 | **681** | 1 | 229s |
| A | **8-bit** | **707** | **2** | **0** | **190s** |
| B | 4-bit | 425 | 0 | 2 | 231s |
| B | **8-bit** | **503** | 0 | **1** | 245s |

The malformed-block column is the story. In point mode the model should emit
point blocks; 4-bit emitted 681 four-value box blocks on frame A, which roughly
doubled the apparent count before filtering. 8-bit emitted 2. That matches what
the conversion notes warn about — the 4-bit build quantises the tied
`embed_tokens`/`lm_head`, and that is where coordinate-token precision lives.

8-bit also found ~13-18% more animals and was no slower. It costs 4.14 GB
against 2.96 GB, which is irrelevant on any machine that can run either.

Caveat from the rendered overlays: 8-bit produced a cluster of ~15 false
positives on wet sand at the waterline that 4-bit did not. It is the better
build overall, not a flawless one.

### Is the full-precision original better? No.

`nvidia/LocateAnything-3B` (bf16, 7.66 GB) was run under PyTorch/MPS on the same
dense colony crop, autoregressive decoding, same prompt:

| Build | Points | Malformed |
|---|---|---|
| bf16 original | 46 | 0 |
| **8-bit MLX** | **46** | **0** |

Identical. The 8-bit conversion loses nothing measurable on this task, at 4.14 GB
instead of 7.66 GB, in a runtime that actually installs on a Mac. The original
needs `torch`, `transformers==4.57.1`, `cv2`, `lmdb`, `peft`, and `decord` —
which has no macOS arm64 wheel at all and has to be stubbed. It is worth having
as a reference, not as a runtime.

## Prompting

The model was trained on grounding-style instructions. What works:

| Goal | Prompt | Mode |
|---|---|---|
| Everything | `Detect all objects in the image.` | box |
| One class | `person` | box |
| Several classes | `person</c>car</c>traffic light` | box |
| Referring expression | `the person holding the phone` | box |
| Text / OCR | `Detect all text in the image.` | box |
| GUI grounding | `Detect all interactive UI elements.` | box |
| **Counting a crowd** | `Point at every animal.` | **point** |

A prompt beginning "Point at…" switches the model into point mode, which
returns one dot per instance instead of boxes. That is the only mode that
separates individuals in a densely packed group — see the section below.

Multiple classes are separated by the literal `</c>` token — that is the
delimiter the model was trained with.

**Decoding is autoregressive, and there is no mode selector.** Two reasons,
both measured:

`mlx-vlm` defines a Parallel Box Decoding path (`pbd_generate`, `pbd.py`) but
never calls it — `generate()` accepts `generation_mode` through `**kwargs` and
discards it. Passing `hybrid` and `slow` produces byte-identical output because
both are plain autoregressive decoding. A mode control here would be a knob
wired to nothing.

And autoregressive is the right choice anyway. Running the reference
`nvidia/LocateAnything-3B` under PyTorch, where PBD *does* engage, on one dense
colony crop:

| Decoding | Points | Malformed blocks | Time |
|---|---|---|---|
| `hybrid` (real PBD) | 43 | **654** | 69.4s |
| `slow` (autoregressive) | **46** | **0** | **11.0s** |

PBD is designed for throughput on scenes with a moderate number of objects. On a
dense uniform crowd it floods the output with malformed box blocks — slower
*and* worse.

## Counting a dense group — read this before trying

Two things about this model are not obvious and cost a lot of time to discover.

**1. Box mode cannot separate individuals in a packed group.** Not at any zoom.
Measured on aerial seal-colony footage: `seal` returns a null box, `animal`
returns a *single* box around the entire colony — and it still does that on a
90px crop blown up to 1024px where each animal is ~300px. Use **point mode**
(`Point at every animal.`) for anything you want to count.

**2. Point mode has a resolution threshold, and below it the decoder lies.**
When targets arrive at the encoder too small, the coordinate decoder does not
give up — it emits a plausible sequence: rows of points at identical `y`,
spaced a constant ~16px apart, marching across the frame. The count looks
reasonable. The points are fiction.

Measured on a 720×1280 frame of a seal haul-out:

| Source crop | Target size in crop | Result |
|---|---|---|
| whole frame | ~25px | null, or one box around everything |
| 283×503 | ~50px | **fabricated** — 128 points, 16 in a straight line, 95% in one half |
| 180px | ~150px | **genuine** — points land on animals |
| 90px | ~300px | genuine |

So tile *size* is the control that matters, which is why the tiling setting is
in pixels rather than a grid count. 180px is the verified-good setting for this
kind of footage; drop to 120px if targets are smaller still.

The lesson generalises past seals: **verify localisation by rendering it, never
by reading the count.** A count of 128 and a count of 462 looked equally
plausible in a JSON response; only one of them was a real census.

### False positives, and why sharpening makes them worse

Points sometimes land where there is no animal. Measured rather than guessed,
on 180px crops of the same frame:

| Region | as-is | blurred (r=1.2) | sharpened |
|---|---|---|---|
| open sand, genuinely empty | 0 | 0 | 0 |
| waterline (wet sand, shingle) | 20 | **6** | 35 |
| dense colony (real animals) | 46 | **40** | 48 |

The model is not hallucinating indiscriminately — it returns nothing on clean
sand and ignores smooth water entirely. Every spurious point sits on *mottled*
ground where, at roughly 30 source pixels per animal, the texture is genuinely
ambiguous with a seal.

That explains why the obvious remedy backfires. Sharpening raises false
positives 75% while adding only 4% real detections, because the spurious hits
live in compression noise rather than structure. A mild Gaussian blur does the
reverse: it removes ~70% of them for ~13% of the true ones. Hence the
**Denoise** control, and hence no sharpening option.

Genuine source resolution would help. Upscaling will not — a 180px crop
enlarged to 1024px is a large blurry 30px animal, never a detailed one.

## Which engine to use — CountGD, measured

Two engines ship. **Use CountGD.** Head-to-head on the same 1698×1082 aerial
still, against the same hand-verified empty ground:

| Engine | Found | False positives | Time | Tiling |
|---|---|---|---|---|
| LocateAnything 3B, 12 tiles | 248 | 1 | 67.0s | required |
| CountGD, tiled | 329 | 1 | 18.7s | optional |
| **CountGD, whole frame** | **389** | **0** | **2.1s** | **none** |

57% more animals, zero false positives, **32× faster**, and it does not need
the tiling machinery at all. It also returns a real **confidence score** per
detection — the thing the grounding VLM structurally cannot provide, and the
reason every workaround in this README exists.

LocateAnything remains useful for one thing CountGD cannot do: arbitrary
referring expressions ("the person holding the phone") rather than a single
noun phrase. For counting, it is strictly worse.

### On video too — and raw counts mislead

Same four 720×1280 frames, animals ~25px and touching:

| Frame | CountGD full | CountGD 250px tiles | LocateAnything 28 tiles |
|---|---|---|---|
| 0 | 525 | 656 | 703 |
| 1 | 493 | 643 | 685 |
| 2 | 419 | 570 | 580 |
| 3 | 218 | 551 | 560 |

LocateAnything appears to win on count. It does not. On terrain verified empty
by eye, frame 0:

| | Total | On open water | On bare sand |
|---|---|---|---|
| LocateAnything | 703 | **20** | 3 |
| **CountGD tiled** | 656 | **0** | **0** |

At least 23 of LocateAnything's extra detections are on ground with no animals.
CountGD finds slightly fewer things and is right about all of them — at 27s per
frame against ~190s. **A higher count is not a better count**, which is why
every comparison here is scored against known-empty ground rather than by
totalling detections.

### When to tile

| Target size in source | Setting |
|---|---|
| ≥40px (stills, low passes) | **whole frame** — 2.1s, no tiling |
| ~25px (this video) | **250px tiles** — whole-frame drops to 525 and is unstable (one frame collapsed to 218) |

CountGD resizes its input to 800px on the short side, so below roughly 40px per
animal the whole-frame path starts losing targets. Tile at ~10× target size.

### Running CountGD

It needs its own interpreter — torch 2.2.1 + transformers 4.39.1, which cannot
coexist with the MLX stack — so `countgd_engine.py` shells out to
`.venv-countgd`. Model load there is ~0.7s, cheap enough that a process per
request beats a persistent sidecar.

```bash
uv venv --python 3.12 .venv-countgd
uv pip install --python .venv-countgd/bin/python \
  torch==2.2.1 torchvision==0.17.1 transformers==4.39.1 numpy==1.26.4 \
  timm addict yapf opencv-python-headless pycocotools scipy termcolor \
  colorlog pyyaml safetensors matplotlib
git clone https://github.com/niki-amini-naieni/CountGD.git
# checkpoint_best_regular.pth from the nikigoli/countgd Space, plus
# google-bert/bert-base-uncased, into CountGD/checkpoints/
```

Set `COUNTGD_REPO` to the clone path. The Engine selector appears in the UI
automatically once `/api/state` reports `countgd: true`.

## Getting to an exact count

Short version: **the model gets you high precision, an operator supplies the
recall, and the export records which.** No zero-shot model reaches an exact
count on dense aerial imagery, and chasing one is chasing something that is not
well defined — see below.

### What is actually measured

Against a hand-verified empty region (250×200px of bare sand, ground truth = 0
animals) and the surrounding empty strip which contains ~2 real animals:

| Tile size | Points in empty strip | False positives |
|---|---|---|
| **400px** | 1 | **~0** |
| 250px | 23 | ~21 |
| 180px | 5 | ~3 |

At the right tile size **precision is effectively solved**. The remaining error
is recall: on a 1698×1082 still the model returned 248 points where visual
inspection shows 300+ animals.

### Why not just push for a better model

In the densest clusters the animals physically overlap — roughly 90 animals in
a 250×200px region, about 25px each. Counting those by eye is reliable only to
about ±6%. When careful human counting disagrees with itself by 6%, "100%
accuracy" has no fixed target to hit. Published work agrees on the shape of the
answer: HerdNet, purpose-built for exactly this task, reports F1 73.6% and
deploys as a *semi-automated* pipeline where a human verifies the model's
proposals, cutting verification time by 70%.

### Verify mode

Hence the operator loop. Press `v` or click **Enable verify mode**, then:

- click an animal the model missed → adds a point (blue)
- click a dot → removes it
- `⌘Z` / **Undo**, or **Reset edits**
- live tally of detected / added / removed / verified total

Because false positives are already ~0, this is almost entirely an *adding*
workflow, which is the fast direction. The JSON export carries a
`verification` block recording `operator_verified`, and the added and removed
counts — so a checked number is never confused with an unchecked one.

## Temporal consensus

The model emits no confidence score, so single-frame counts cannot be trusted:
four frames of the same colony 1.5s apart returned 703 / 685 / 580 / 560 — a 25%
spread on a group of animals that barely moved.

Consensus builds the missing confidence from agreement. Detections are matched
across frames and each surviving target carries a `support` count: how many
frames independently found it. A hauled-out animal is found repeatedly; a
texture artefact on wet sand appears once.

| Confirmed in | Targets |
|---|---|
| ≥1 frame | 847 |
| ≥2 | 721 |
| ≥3 | 557 |
| **≥4 (all)** | **403** |

The ≥4 render is visibly the cleanest output this project produces — the
waterline false positives that survive every single-frame run are gone.

### Two independent detectors agree

Consensus run over CountGD's video detections, same registration and clustering
as the LocateAnything run so only the detector differs:

| Seen in ≥ | CountGD | LocateAnything |
|---|---|---|
| 1 frame | 764 | 847 |
| 2 | 679 | 721 |
| 3 | 576 | 557 |
| **4 (all)** | **401** | **403** |

At the strictest threshold a counting model and a grounding VLM — unrelated
architectures, different failure modes — land within 0.5% of each other. With
no ground truth available, independent convergence is the strongest evidence
there is that ~400 is the real number of confidently-visible animals in this
footage.

CountGD is cleaner upstream too: 764 unique clusters against 847, and 52% of
them survive to all-four support versus 48%. Fewer one-off spurious hits,
consistent with its zero false positives on verified-empty ground.

### Registration is the hard part

Frames must be aligned before matching, and translation is not enough. A drone
yaws and changes altitude, so the residual after phase correlation was tens of
pixels — larger than an animal. Measured effect at a 15px matching radius:

| Registration | ≥4 frames | unique clusters |
|---|---|---|
| translation (phase correlation) | 115 | 1201 |
| **similarity (ORB + RANSAC)** | **403** | **847** |

Translation-only under-confirmed by 3.5× and split one animal into several
clusters. The tell was that support-4 kept climbing as the matching radius grew
(34 → 353 from 10px to 60px) — proof the same animals were being found and
landing apart, not that the model was unstable. With affine registration the
count converges instead: 403 at 15px, 410 at 25px.

`estimate_transform` uses ORB features with RANSAC, which tolerates the many
false matches you get on a field of near-identical animals, and falls back to
phase correlation if it cannot find a stable fit. The API reports which method
ran per frame, with inlier counts, so alignment is auditable.

### Things that did not work (so you don't retry them)

**SAM 3.1** (`mlx-community/sam3.1-bf16`). Looks ideal on paper: promptable
concept segmentation returns every matching instance at once with masks and
confidence scores, Meta reports it matching or beating MLLMs on CountBench and
PixMo-Count, and it is commercially licensed. On this footage it fails. Same
180px colony crop where LocateAnything finds 46 plausible animals:

| score threshold | boxes | what they are |
|---|---|---|
| 0.30 (near default) | 0 | — |
| 0.08 | 2 | only the high-contrast dark animals |
| 0.03 | 59 | misaligned rectangles, not tracking outlines |
| 0.01 | 182 | noise |

Scores peak at 0.179 with a median of 0.018, against a 0.5 default — the concept
head is at its noise floor. Prompt discrimination is weak too: `rock` returns 90
boxes and `sand` 63, versus 182 for `animal`. Top-down aerial imagery of hundreds
of touching ~30px animals is far outside its training distribution, and the
counting benchmarks it wins are ordinary photographs with modest counts.

Worth keeping for normal imagery — it is permissively licensed and fast — but it
is not the tool for an aerial census.

**The bf16 original** — see the quantisation section: identical output to 8-bit
MLX, three times the install pain.

### The degeneracy guard

Because that failure is invisible in aggregate, `degeneracy.py` screens every
tile before its points are merged. It looks for runs of points that are
collinear at constant stride — a pattern that essentially does not occur in
real detections but is the signature of a runaway decode. Flagged tiles are
discarded and reported in the UI as "N tiles discarded", never folded silently
into the total.

Lopsided coverage is tracked too, but only as an advisory. Whole-frame it is a
strong tell; on a single small tile it is normal, because a crop straddling the
edge of a group genuinely has every target on one side. Rejecting on it would
punch holes in exactly the boundary regions a census needs.

## Dense scenes (tiling)

A whole-frame pass is the wrong tool when the targets are small and numerous —
a wildlife colony from a drone, a crowd from a stadium camera, a dense document.
The vision encoder downsamples the frame, and a 40-pixel animal survives as
almost nothing.

Tiling splits the frame into an `n×n` grid of overlapping crops, upscales each
one, runs the model per crop, maps the boxes back into full-frame coordinates
and merges the seam duplicates with NMS:

**Rule of thumb: tile ≈ 10× the size of one target.** Bigger tiles miss small
animals; smaller tiles are worse, not better. Measured on a 1698×1082 aerial
still with ~40px animals:

| Tile | Points | Tiles | Time | Rendered quality |
|---|---|---|---|---|
| **400px** | 248 | 12 | **67s** | **clean — ~4 false positives** |
| 250px | 355 | 28 | 101s | ~30 false positives on empty sand |
| 180px | 346 | 54 | 297s | slower, no better |

The extra 107 detections at 250px are mostly noise. Over-zooming means more
tiles containing nothing but sand, and on featureless ground at high
magnification the model reads texture as animals — the same mechanism that
makes sharpening harmful. Note also that 400px produced the *most* malformed
blocks (226) and still the best output: malformed count is not a quality proxy,
only the render is.

| Tile size | Tiles on a 720×1280 frame | Use for |
|---|---|---|
| off | 1 | ordinary scenes, a few large objects |
| 360px | 8 | moderately busy frames |
| 240px | 15 | crowds |
| **180px** | **28** | **dense colonies, aerial survey — verified** |
| 120px | 60 | very small targets |

Cost scales with tile count: 180px on a 720×1280 frame is 28 forward passes,
about two minutes on an M3 Max. On a 60-frame video that would be 1680
inferences, so sample a handful of frames rather than the whole clip when
running dense.

Two guards run on every result, tiled or not: boxes covering ≥92% of the frame
are discarded (on a uniform dense scene the model sometimes returns one box
around the whole group instead of the individuals, and that box swallows every
real detection during NMS), and near-duplicates are collapsed both by IoU and by
containment, which is the shape a seam duplicate actually takes — a partial
animal in one tile is a whole animal in its neighbour.

Frames are extracted at up to 2048px on the long edge, because tiling crops from
those files and resolution thrown away at extraction cannot be recovered.

## Layout of the prototype

The service has its own tree — see [What's in here](#whats-in-here) at the top.
This is the `./run.sh` app only.

```
la_studio/
  server.py        FastAPI: upload, frame extraction, detect, SSE batch run
  model_worker.py  MLX model wrapper, serialised behind one lock
  boxes.py         parser for <ref>label</ref><box><x1><y1><x2><y2></box>
  frames.py        ffmpeg probe + frame sampling
web/index.html     the entire UI, no build step
```

Uploads live in `~/.locateanything-studio/workspace/<id>/` and are never sent
anywhere — inference is entirely local.

## Licence

The **app** in this repo is yours to do as you like with.

The **model** is not. `nvidia/LocateAnything-3B` ships under the NVIDIA License:
academic and non-profit research use only, **commercial use is not permitted**.
The MLX conversions inherit that restriction, as do the upstream component
licences (Qwen2.5-3B-Instruct under the Qwen Research License, MoonViT-SO-400M
under MIT). Keep that in mind before wiring this into anything that ships.
