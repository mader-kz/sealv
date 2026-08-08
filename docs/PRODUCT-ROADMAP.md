# SEALv — product roadmap

SEALv counts Caspian seals from drone footage and produces a document an
ecologist can sign. Its differentiation is not the detector. It is **honesty**:
every number on every screen traces to measured data or to a named human's
explicit entry, machine counts carry a band and the basis that produced it,
human entries carry a visible `manual` basis and an attribution, and nothing is
ever invented to fill a gap. A gap is printed as a gap.

That rule is the product. Each feature below is judged first on whether it
keeps the rule, and only then on whether it is useful.

---

## Where the platform is today (base commit `b8ac8d9`)

Working: real ingest (drone video/still + SRT/JSON sidecar + hand pin), a real
counting engine behind a job queue, per-animal points, count bands with a
stated basis, a map with colony chips and hulls, an Evidence view of the actual
frame with every animal marked, a windowed sortie list and detection table, a
current-estimate headline (2 km site clustering, observation sum demoted), an
analytics panel and a Unicode PDF report, GeoJSON/CSV exports, and a parallel
hydrate that restores a season after F5.

Missing, and each one is a hole in the honesty claim rather than a missing
convenience:

| Hole | Consequence today |
|---|---|
| No duplicate detection | The same file ingested three times is three sorties and three colonies. The fixture's ~875 real animals report as 1737. |
| No capture date | Every sortie is stamped with the day the count job ran. The timeline, the current estimate's "latest visit per site" rule, and the report's date column are all the processing clock. `/v1/stats.over_time` is structurally empty. |
| No writable text anywhere | Two text inputs in the whole app, both filters. `survey.notes` exists, is accepted at upload, and is never sent, never read back, never shown. |
| No survey PATCH | Correcting an altitude typo means re-running a 3-minute detection pass and minting a second run over the same footage. |
| No manual counts | The boat/shore census the drone counts are validated against cannot be entered at all: `run.job_id` and `run.media_id` are both `NOT NULL`. |
| No site identity | A "site" is a browser-side 2 km cluster. The service's `site` table has zero rows and the client has never heard of it. |
| Review is not performable | 1476 detections, no keyboard verdicts, no worst-first order, no way to scope to one sortie, no pixels next to a verdict control. Verified share: 0%. |
| No attribution | Every verdict in the append-only edit log is written by the literal string `platform`. |
| Nothing is retirable | "Remove" filters a JavaScript array. The sortie is back on the next page load, and so is the estimate. |
| Ingest is one overwritable string | 30 files produce one log line, no per-file state, no byte progress, silent discards, and every failure vanishes on F5. |

---

## Wave 1 — this run

Ten scope items plus what the job audit proved is missing underneath them. All
backend work is additive endpoints and idempotent schema growth; the legacy
operator webapp reads `/v1/stats` defaults and no existing response shape
changes.

### 1. Sortie notes (the user-named gap)
`survey.notes` gains a read path (`sv.notes` and `sv.operator` join the
`latest_runs` projection) and a write path (`PATCH /v1/surveys/{id}`, capped at
4000 characters, stored raw, rendered as text and never as HTML). A debounced
textarea in the inspector with explicit saved / saving / unsaved state, an
attribution line naming who wrote it, the note in the PDF's per-sortie block
and a `notes` column in the sortie CSV.
**Honesty angle:** the field observation — ice, disturbance, "counted the same
haul-out twice" — is the one piece of evidence the machine can never produce.
The dashboard's existing machine-generated "NOTES" section is renamed to
"Derived summary" so a generated sentence and a human's sentence never sit
under one heading.
**Cost:** small backend, small UI. Blocked on nothing but the survey id.

### 2. Manual ground counts
`POST /v1/observations` mints a survey plus a run with `engine='manual'`,
`basis='manual'`, `count_low = count_best = count_high = n` and **no band** —
the equal bounds are the honest statement that a human count has no cross-frame
spread, not a fabricated ±0 interval. It participates in the site estimate as
an ordinary sortie (and, being the latest visit, can legitimately supersede a
drone count at that site).
**Honesty angle:** labelled `manual` in the chip, the list row, the inspector
pill, both CSVs and the PDF, and attributed to a named person.
**Cost:** medium — it forces the schema change below.

### 3. Site naming
`site` becomes reachable: `PATCH /v1/sites/{id}` to rename, `site_id` /
`site_name` / `site_lat` / `site_lng` on every archive row, and a picker in the
inspector that either reuses a site within 2 km or creates one at the cluster
centroid, then assigns it to **every sortie already in that cluster**.
Grouping becomes the union of two relations — explicit `site_id` equality
**and** 2 km geometric linkage — so naming a place can only ever merge sorties,
never split them.
**Honesty angle:** a name must never move the headline. Unnamed sites keep
printing coordinates, which is already the honest fallback.
**Cost:** small backend, medium UI.

### 4. Site dynamics
A repeat-survey row becomes a drill-in: the whole ordered series as dots with
low–high whiskers, hand-rolled SVG in the existing chart style, each entry
labelled with date, band, basis and verified share. `siteSeries()` already
computes all of it and the panel throws it away.
**Honesty angle:** an entry with no count renders as a gap, never as zero. No
regression line, no forecast.
**Cost:** small — new rendering over data already in memory.

### 5. Data-trust panel
Verified / reviewable-unreviewed / **not reviewable** as three separate
numbers, per sortie and per season; GSD provenance split into measured
(`explicit`, `optics`), assumed (`assumed_*`) and unknown; the sorties carrying
engine caveats, with the run's stored `false_positive_basis` quoted verbatim;
failed ingests as their own line; retired sorties as their own line.
**Honesty angle, and a correction to the brief:** the fixture's three runs of
one photo are the same bytes at the same parameters through a deterministic
pipeline. Their spread is exactly 0, and publishing "the engine repeats within
0%" would be this product's first fabricated confidence figure. The panel
states the two things that were actually measured instead — *determinism*
("same file, same parameters, N runs, identical result") and the *cross-frame
spread* the video band already carries.
**Cost:** medium UI, one extra field on the archive row.

### 6. Review at scale
The triage walk lives inside the Evidence view, where the pixels are: a point
cursor over the frame, lowest score first, the frame auto-cropped to the
current animal, `V` validate / `X` false / arrows / space, a progress counter,
verdicts through the existing batch endpoint. The table gains an ascending
score sort, a per-row validate control that costs exactly what the reject
control costs, a sortie scope selector showing the short run id (three sorties
share one filename today), an `Unsaved` filter with a retry, a saving
indicator, and a pass — filter, sort, cursor, scroll — that survives closing
the drawer. Per-sortie verified/total on the list rows and in the inspector,
with a "Review this sortie" entry point.
**Honesty angle, and a second correction:** a bulk validate over 1476 rows
currently fires with no confirmation and cannot be undone. The affirmative
direction gets a confirmation that names what it is about to certify, and no
control is ever labelled "Restore" while it writes "validated" — the label says
what will be recorded. The aggregate marker standing in for 562 animals becomes
non-actionable, and a verdict that cannot reach the archive gets the same
`unsaved` treatment as a rejected write instead of a console warning.
**Cost:** the largest UI item in the wave.

### 7. Ingest that survives a real field day
A per-file queue in the store keyed on the File object (not the lowercased
stem — two cards both starting at `DJI_0001` currently collapse and the second
file is discarded silently). Every dropped file gets a row, including rejected
ones, with the real filename and a reason. XHR byte progress, honest phase
labels (`uploading N%` → `queued` → `counting frame i/n` → `writing`) — the app
currently prints "counting" while the file is still on the wire. One upload and
one watch in flight at a time; a second drop appends instead of being refused.
Multiple files can wait for a location at once, each with its own pin and
confirm. Failures persist: `GET /v1/jobs?status=failed` renders a section that
survives F5, with a retry that re-queues the existing media rather than
re-uploading the file, and a cancel for queued work. The Ingest button stops
being disabled for the whole hydrate.
**Honesty angle:** an anchor is bound to the file it was armed for, so a stale
pin can never be silently applied to the next photo — the current behaviour
publishes a fabricated coordinate to four decimals. Pinned sorties carry a
visible `pinned by hand` location basis, and a live lat/lng readout while
pinning.
**Cost:** the largest package overall.

### 8. Metadata correction, including the date
`PATCH /v1/surveys/{id}` over `captured_at`, `altitude_m`, `gsd_cm_px`,
`tide_state`, `operator`, `notes`, `site_id`, `lat`/`lng`. An edit affordance in
the inspector with a downstream notice that is specific and true: the area
recomputes, the count does not, and re-deriving the count needs a re-run;
changing the date moves the sortie on the timeline and may change which visit
the current estimate uses for that site. A survey with no `captured_at` says
"date not recorded — showing when the count ran" rather than printing the job
clock as a flight date. Ingest also starts sending the metadata block it always
could (`captured_at`, `operator`, `altitude_m`, notes) and carries the SRT/MP4
timestamps through the synthesized sidecar, so the date is measured wherever
the file has it.
**Honesty angle:** the date is not cosmetic — the current-estimate headline
picks the latest sortie per site, so today the product's lead number is decided
by processing order.
**Cost:** small backend, medium UI.

### 9. First-run guidance
Empty states that teach upload / review / report and name the accepted file
types up front, instead of a bare CTA.
**Cost:** small.

### 10. Frame picker and quick count (user-demanded)
Selecting a video extracts one frame per second client-side (`<video>` +
`<canvas>`, capped at 12 evenly spaced frames) and shows them **before**
anything uploads. Two explicit paths: **Full analysis** — the whole video,
consensus band across frames, kept visually primary because the band is the
product — and **Quick count** — the picked frame exported as a JPEG and
ingested as an image, basis `single_image`, georeferenced from the video's
embedded track at that frame's timestamp or through the pin flow.
**Honesty angle:** picking a frame never silently replaces full analysis. It is
labelled everywhere as a single frame, and the UI states what is traded away:
no cross-frame band.
**Cost:** medium, self-contained.

### Underneath all ten: what the audit proved was missing
- **Survey identity in the client.** `Footage` carries `runId` and `mediaId`
  and no `surveyId`, and the string `survey` appears nowhere in the frontend —
  while `/v1/stats` has been shipping `survey_id` on every row all along.
  Every record feature writes to a survey. This is the first commit of the wave.
- **Duplicate detection.** `media.content_hash` (SHA-256, computed in the
  existing save pass) plus `GET /v1/media/by-hash/{sha}`. The client hashes with
  WebCrypto before a byte goes on the wire, and offers "already counted on
  <date> — open it" versus "count again"; a deliberate re-count attaches to the
  same `survey_id` so the archive collapses it into one sortie instead of two
  colonies. Where `crypto.subtle` is unavailable (the documented plain-http LAN
  deployment) the check degrades to the server's answer in the upload response.
- **Retirement, not deletion.** `survey.retired_at` / `retired_reason` /
  `retired_by`, a retire route, `retired_at IS NULL` in the archive query with
  an `include_retired=1` escape hatch. This is an evidence archive: withdrawal
  is soft, attributed, reversible and counted in the trust panel.
- **A person.** Not auth (correctly deferred) — one "who is recording?" field,
  persisted locally, threaded into every edit's `operator`, the upload
  metadata, the manual count and the retire reason, and printed in the report.
  An empty value sends `null`, because "nobody said" is a truthful record and
  `platform` is not.
- **The corrections log becomes readable.** `GET /v1/runs/{id}/edits` over the
  existing `db.list_edits`, surfaced as an edit-history disclosure. The schema
  calls this log "survey evidence" and no screen has ever shown a row of it.
- **`hasResult()` beside `isPlaced()`.** A failed ingest is currently counted as
  a sortie in the observation line and the "without GSD" tally, and its
  client-invented track appears in the list and the CSV. One predicate, gating
  the sortie count, the area tallies, the CSV and the PDF.

### Deliberately not in wave 1
Multi-user auth and roles, public dashboards, seasonal PDF report packs,
ice/bathymetry layers, offline field mode, URL permalinks.

---

## Wave 2 — the loop the wave-1 work exposes

- **Cancel a running count.** Wave 1 cancels queued jobs only. Per-job
  cooperative cancellation needs the worker to check its own row between frames
  and unwind cleanly; the lease and `STOP` plumbing are already there.
  *Honesty: a 4 GB mis-drop should not have to be waited out.* Small–medium.
- **A `clear review` verdict.** Today `auto` is a state a point can leave and
  never return to, so a mis-click permanently manufactures a human verdict.
  Wave 1 relabels the controls honestly; wave 2 adds the op end-to-end so
  "nobody has looked at this" is recoverable. Small backend, small UI.
- **Reviewable video frames.** 562 of the fixture's animals have real point
  rows with pixel coordinates and scores, but their sortie is a video and the
  Evidence view has no frame to show. The service already writes per-job frames
  (`/media/{id}/frames/{job_id}/{name}`); exposing the frame index turns
  "not reviewable" into reviewable. Medium.
- **Manual counts in the time series.** `/v1/stats.over_time` and `per_site` are
  built by a CTE that inner-joins media, so a media-less manual run does not
  reach them. Wave 1 routes manual counts through `latest_runs` (which is what
  the app hydrates from) and documents the gap. Small.
- **Compare two sorties side by side.** Two Evidence frames, two bands, one
  screen — the natural next step after site dynamics. Medium.
- **Export completeness.** `run_id`, `site`, `basis`, `low/best/high`,
  `gsd_source`, `operator` in the GeoJSON properties and both CSVs; a PDF
  header block naming the operator, the reporting period, the brush window and
  "N of M sorties in the archive". Wave 1 lands the report-side half; the
  per-animal artifacts are the rest. *Honesty: a truncated archive that does not
  admit it is truncated is the codebase's own rule, applied to the document
  where it matters most.* Small.
- **Classified ingest errors.** A field worker currently receives a raw
  `CalledProcessError` including the full ffprobe argv. Keep the raw text as
  the record; classify the common cases into a sentence at the API boundary.
  Small.
- **A points page.** `GET /v1/runs/{id}/points` returns every point; at
  hundreds of sorties the hydrate is the bottleneck. Medium.

## Wave 3 — the platform

- **Multi-user, auth and roles.** Wave 1's local reviewer name is the honest
  30-line version; real attribution needs identity the service can verify.
  *Honesty: an акт учёта signed by an unverified free-text name is weaker
  evidence than one signed by an account.* Large.
- **Public / shared dashboards.** A read-only link for a colleague with no
  login, carrying the same caveats and the same "N of M" admissions as the app.
  Medium.
- **Seasonal report packs.** Several seasons, one document, with the repeat
  structure and the verification share per season. Medium.
- **Ice and bathymetry layers.** Haul-out counts swing enormously with ice;
  `survey.sea_ice_pct` and `tide_state` exist and nothing renders them. Medium.
- **Offline field mode.** The documented deployment is a laptop on a boat.
  Queue ingests locally, reconcile on return. Large.
- **URL permalinks.** A site, a sortie, a review pass addressable by URL — the
  precondition for sharing anything specific. Small–medium.
- **Postgres.** `db.py` says the port is one function (`claim_job`); the wave-1
  `run` table rebuild is the only thing that makes it two. Medium.

---

## Русская сводка

**Продукт.** SEALv считает каспийских тюленей по дрон-съёмке и выпускает
документ, который эколог может подписать. Отличие продукта — не детектор, а
**честность**: каждое число прослеживается либо к измерению, либо к явной
записи названного человека; машинные подсчёты несут диапазон и основание,
ручные записи — видимую пометку `manual` и авторство; пробел печатается как
пробел, а не заполняется догадкой.

**Что не так сейчас.** Нет дедупликации — один файл, загруженный трижды, даёт
три «колонии» (в фикстуре ~875 реальных животных отображаются как 1737). Нет
даты съёмки — всюду стоит дата запуска подсчёта, и именно она решает, какой
визит попадёт в главную цифру. Во всём приложении нет ни одного поля ввода
текста. Нет `PATCH` для survey — исправление высоты полёта стоит трёхминутного
пересчёта. Ручной подсчёт структурно невозможен. «Сайт» — это кластер в
браузере, таблица `site` пуста. Проверка 1476 детекций физически невыполнима.
Все вердикты подписаны строкой `platform`. «Удалить» правит массив в памяти —
после F5 сортия возвращается.

**Волна 1 (этот прогон).** Заметки по сортии; ручные наземные подсчёты
(`basis='manual'`, без выдуманного диапазона); именование сайтов (объединение,
никогда не разделение — имя не должно двигать оценку); динамика сайта точками с
усами; панель доверия; выполнимая проверка с клавиатуры прямо поверх кадра;
переработанный ингест (очередь по файлам, прогресс по байтам, сохраняемые
ошибки, повтор, отмена, дедупликация по SHA-256 до загрузки); правка метаданных
включая дату; обучающие пустые состояния; выбор кадра из видео с двумя явными
режимами. Плюс то, что вскрыл аудит: `surveyId` на клиенте, мягкое снятие
сортии с учёта (не удаление), имя оператора вместо `platform`, читаемый журнал
правок, предикат `hasResult()` — сейчас неудавшийся ингест считается сортией.

**Две поправки к заданию, доказанные кодом.** (1) «Повторяемость движка по трём
прогонам одного фото» измерить нельзя: это одни и те же байты с теми же
параметрами через детерминированный конвейер, разброс ровно 0, и публикация
«движок повторяется в пределах 0%» была бы первой выдуманной цифрой в продукте.
Вместо неё — детерминизм и реально измеренный меж-кадровый разброс. (2)
`PATCH /v1/surveys` в задании описан как существующий — его нет, его надо
построить.

**Волна 2.** Отмена работающего подсчёта; операция «снять отметку проверки»
(сейчас `auto` — состояние без возврата); просмотр кадров видео для проверки;
ручные подсчёты во временном ряду; сравнение двух сортий; полнота экспортов;
классифицированные ошибки ингеста.

**Волна 3.** Мультипользовательский режим и роли; публичные дашборды; сезонные
пакеты отчётов; слои льда и батиметрии; офлайн-режим в поле; постоянные ссылки;
переход на Postgres.
