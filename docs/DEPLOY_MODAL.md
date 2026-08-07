# Deploying CountGD on Modal

Inference runs on Modal; the API, worker, database and web app run somewhere
small and always-on. This split exists because the two halves have opposite
shapes: the API must always answer, while inference is idle for days and then
busy for minutes.

```
SEALv API + worker + SQLite + webapp   →  Railway / Fly / a VM  (~$5/mo)
        │  countgd_engine.detect_many()
        ▼
CountGD on GPU                          →  Modal (scale-to-zero, $0 idle)
```

It costs nothing structurally: `countgd_engine` already ran CountGD in a
separate **process**, because torch 2.2.1 cannot share an interpreter with the
transformers 5.x the rest of the tree uses. Replacing a process boundary with a
network boundary changes the transport, not the design.

---

## Deploy

```bash
pip install modal
modal token new                      # once, opens a browser

cd sealv
modal run modal_app.py::fetch_weights # once, ~1.6 GB into a Volume
modal deploy modal_app.py
```

Then point the service at it:

```bash
export SEALV_MODAL_APP=tulen-countgd
```

That variable is the whole switch. Unset, everything runs locally exactly as
before — a dev box needs no Modal account and no network.

### In a container (Railway), three variables, not one

`modal token new` writes `~/.modal.toml`, which a container does not have. The
client reads credentials from the environment instead:

```
SEALV_MODAL_APP=tulen-countgd
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

Read the two token values out of `~/.modal.toml` on the machine where you ran
`modal token new`, and set them as Railway variables.

Verified end to end: the amd64 image with these three set returns **389** on the
reference still — the same count as local CPU and as calling Modal directly.
The container never loads model weights in that mode, which is why a small
always-on instance is enough.

Measure it before trusting it:

```bash
modal run modal_app.py::smoke --image-path ~/Downloads/your_survey_still.jpg
```

This prints a cold single call and a warm batch of 8, so the GPU speedup is a
number you have rather than one I estimated.

---

## What the design is protecting against

**Cold start, not inference, is the cost.** The forward pass is a fraction of a
second; loading the checkpoint is seconds. So:

- weights live in a **Volume**, not in image layers — an image rebuild would
  otherwise re-download 1.6 GB, and Volumes are $0.09/GiB-month with the first
  TiB free
- the model loads in `@modal.enter()`, once per **container**, not per call
- `scaledown_window=60` keeps a container alive across the tiles of one sortie
  without paying to idle between sorties

**Per-call overhead, not GPU choice, decides the bill.** A tiled sortie is 60+
crops. As 60 round trips, scheduling costs more than the inference. Hence
`detect_many()` / `detect_batch` — always batch a frame's tiles into one call.

**T4 is deliberate.** CountGD is a Swin-B GroundingDINO derivative. An A10G is
~1.9× the price for no useful gain at this size. Override with `SEALV_GPU` only
after measuring.

---

## What $30 buys — measured, not estimated

Rate card: T4 $0.000164/s. $30 ≈ **183,000 GPU-seconds ≈ 51 GPU-hours**.

Measured on a T4 against the 1698×1082 aerial still (389 animals):

| | Measured |
|---|---|
| Warm, per image | **0.87s** ($0.000143) |
| Cold start (scaled to zero) | **~44s** — container boot + 1.2 GB checkpoint load |
| Speedup vs local CPU | **2.4×** (2.1s → 0.87s) |

| Job | Warm | Cold | $30 buys (warm) |
|---|---|---|---|
| Still, whole frame | 0.9s / $0.0001 | 45s / $0.0074 | ~210,000 |
| Still, 12 tiles batched | 10.4s / $0.0017 | 54s / $0.0089 | ~17,500 |
| 4-frame sortie, 60 tiles | 52s / $0.0086 | 96s / $0.0157 | **~3,500** |

**Cold start dominates at low volume.** A single still costs $0.0001 warm and
$0.0074 cold — a 50× difference, and if you fly one sortie a day *every* call is
cold. At that pattern budget for the cold column: ~1,900 sorties on $30 rather
than 3,500. Still far more than a field season needs.

### Why only 2.4×, and what would fix it

The fused CUDA kernel for deformable attention is not compiled, so inference
uses the pure-PyTorch implementation. Building `models/GroundingDINO/ops` into
the image with a CUDA-devel base (needs `nvcc`) would likely recover much of the
8× that a fused path gives. It is deliberately not done yet: at 3,500 sorties
per $30 the throughput is not the constraint, and the build adds real
complexity. Revisit only if a measurement says to.

### What would burn the credit

1. **Not batching** — 60 calls instead of 1 pays cold-start-ish overhead 60 times.
2. **`min_containers > 0`** — paying to idle discards the reason Modal wins.
3. **A bigger GPU** — A10G is 1.9× the price; the bottleneck here is the unfused
   kernel, not the card, so it would buy little.

Set a spend cap in the Modal dashboard.

---

## Troubleshooting

**`Cls.from_name` raises NotFoundError** — `modal deploy` has not run, or
`SEALV_MODAL_APP` does not match `APP_NAME` in `modal_app.py`.

**First call takes 30–60s** — expected. Cold container plus checkpoint load.
Subsequent calls within `scaledown_window` are warm.

**`FileNotFoundError` on the checkpoint** — `fetch_weights` has not run, or ran
against a different Volume. Check with `modal volume ls tulen-countgd-weights`.

**Counts differ from local** — they should not; it is the same checkpoint and
the same preprocessing. Compare `info.remote()["version"]` against the local
`countgd_engine.version()`. Both report `checkpoint_best_regular.pth/<bytes>`,
so a mismatch names itself.

**Bill higher than expected** — check for unbatched calls first. `detect_many`
with one image per call has the same cost shape as not batching at all.
