# CI/CD — GitHub Actions to Railway

```
 push / PR ──────────► ci.yml           ~1 min, no build
                       code gate

 git push --tags ────► release.yml
                       ├─ verify   (calls ci.yml — a tag gets no shortcut)
                       ├─ notes    (bilingual EN/RU structure)
                       ├─ deploy   railway up --ci  →  wait for /healthz
                       └─ release  gh release create --latest
```

The GitHub Release is created **last**, only after Railway reports the new
version healthy. A release is an announcement; announcing a version that failed
to deploy is worse than not announcing it.

---

## One-time setup

### 1. Railway

Create the project, then — before the first deploy — attach a **volume mounted
at `/data`**. `railway.json` sets `requiredMountPath: /data`, so a deploy
without it fails fast rather than silently writing the database into a container
layer that disappears on the next restart.

Set these three variables on the service:

```
SEALV_MODAL_APP=tulen-countgd
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

Read the two token values out of `~/.modal.toml` on the machine where you ran
`modal token new`. That is the whole list — `SEALV_DATA_DIR=/data` and
`COUNTGD_REPO` are baked into the image, `SEALV_DB` and `SEALV_WORKSPACE` derive
from the data dir in the entrypoint, and `PORT` is injected by Railway.

Without the Modal variables the container still works; it falls back to CPU
inference at roughly 2s per still while also trying to stay responsive. See
[DEPLOY_MODAL.md](DEPLOY_MODAL.md).

### 2. The Railway token

**Project token, not an account token.** Railway → your project → Settings →
Tokens. An account token produces `Project Token not found`, which reads like a
missing project rather than the wrong kind of credential.

### 3. GitHub

| Kind | Name | Value |
|---|---|---|
| Secret | `RAILWAY_TOKEN` | the project token from step 2 |
| Variable | `RAILWAY_SERVICE` | service name, exactly as Railway shows it |
| Variable | `RAILWAY_HEALTHCHECK_URL` | optional, e.g. `https://<app>.up.railway.app/healthz` |

```bash
gh secret set RAILWAY_TOKEN --env production
gh variable set RAILWAY_SERVICE --body sealv-backend
gh variable set RAILWAY_HEALTHCHECK_URL --body https://your-app.up.railway.app/healthz
```

The deploy job targets a `production` GitHub Environment — create it (Settings →
Environments) and add required reviewers there if a release should need a human
to approve.

Leaving `RAILWAY_HEALTHCHECK_URL` unset skips the health gate, which is fine for
a first deploy when the domain does not exist yet. Set it afterwards: without
it, `railway up --ci` returns when the **build** finishes, not when the new
container is actually serving, so a crash-looping release would still be
published.

### 4. Turn off Railway's own GitHub auto-deploy

If the service is connected to the repo, Railway redeploys on every push to
`main` — which means every commit ships, and the tag-driven pipeline is
decorative. Disconnect the repo in Railway (Settings → Source) and let Actions be
the only thing that deploys.

---

## Cutting a release

```bash
git fetch --tags origin
git tag | sort -V | tail -3          # never assume the latest version

python3 tools/release_notes.py v1.2.0 --scaffold
$EDITOR docs/releases/v1.2.0.md      # fill in both languages

git add docs/releases/v1.2.0.md
git commit -m "Add v1.2.0 release notes"
git tag v1.2.0
git push origin main --tags
```

Notes are written, not generated. Nothing in CI can translate, so a workflow
that generated them would either put English under a Russian heading or drop the
second half. What CI *does* enforce is structure — matching sections, 1:1 bullet
counts, no empty sections, no leftover placeholders:

```bash
python3 tools/release_notes.py v1.2.0 --check
```

That runs in parallel with the code gate, so a missing notes file fails in
seconds rather than after a full deploy.

Re-deploying an existing tag without cutting a new version: Actions → Release →
Run workflow → enter the tag.

---

## Versioning

`1.0.0` is a promise that the public API will not break without a major bump —
not a score out of ten. So the milestones are things the project *earns*, not
things someone picks when it feels ready:

| Version | Means |
|---|---|
| `0.1.0` | Counts, deploys, documented. Precision verified by rendering detections over hand-checked ground. **Recall unmeasured.** Never deployed. |
| `0.9.0` | Deployed and serving. A real survey has gone through it end to end. API still free to change. |
| `1.0.0` | Recall measured against at least one hand-counted frame, and the API considered stable. |

The reason `0.1.0` is not `1.0.0` is the same reason the count is a band and not
an integer, and the same reason `gsd_source` records whether the optics were
real or assumed: this project does not claim more than it measured. Stamping
`1.0.0` on something that has never served a request would contradict that in
the most visible field there is.

Until `1.0.0`, a breaking change bumps the minor version.

---

## Design notes

**CI does not build the Docker image.** That build pulls ~1.6 GB of weights and
installs torch; running it here would take ten minutes to reproduce a build
Railway is about to run anyway. `railway up --ci` streams Railway's build and
fails the job if it breaks — that *is* the check, and duplicating it would prove
nothing new.

**`railway up` is called without `-y`.** With nothing linked, `-y` makes `up`
create a *new* project and deploy into it. That would report success while
publishing to an empty project nobody is watching. The project comes from the
token; the service is named explicitly.

**The CLI version is pinned** (`@railway/cli@5.30.4`) rather than installed from
a `curl | sh` URL, so the deploy step cannot change between two runs of the same
tag.

**The size guard is not paranoia.** Three files in this tree are individually
over GitHub's 100 MB blob limit. A rejected push is the good outcome; the bad
one is a 1.2 GB blob in history, where removing it means rewriting every commit
after it.

---

## Troubleshooting

**`Project Token not found`** — an account token was used. Project tokens live
in the project's own settings.

**Deploy succeeds, health check times out** — the build is fine and the
container is not serving. Check Railway's deploy logs; the usual cause is a
missing `/data` volume, which the entrypoint's preflight refuses to start
without.

**`i18n FAIL`** — a key was added to one locale only. The page's lookup falls
back to English silently, so this never surfaces at runtime for an English
reader. `python3 tools/check_i18n.py` lists exactly which keys and which locale.

**Release job succeeded but the tag is on the wrong commit** — the release notes
are edited by the workflow, never the tag. Move a tag by deleting it (locally
and on the remote) and re-pushing, or cut the next patch version.
