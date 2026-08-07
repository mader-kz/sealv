#!/usr/bin/env bash
# LocateAnything Studio - one-command launcher.
set -euo pipefail

cd "$(dirname "$0")"

VENV="${LA_VENV:-.venv}"
PORT="${PORT:-8077}"
MODEL="${LA_MODEL:-mlx-community/LocateAnything-3B-8bit}"
MLX_VLM_REF="git+https://github.com/beshkenadze/mlx-vlm@feat/locateanything-3b"

if [ ! -x "$VENV/bin/python" ]; then
  echo "==> creating venv ($VENV, python 3.12)"
  uv venv --python 3.12 "$VENV"
fi

if ! "$VENV/bin/python" -c "import mlx_vlm" >/dev/null 2>&1; then
  echo "==> installing runtime dependencies"
  UV_HTTP_TIMEOUT=180 uv pip install --python "$VENV/bin/python" -r requirements.txt

  # --no-deps on purpose: mlx-vlm declares datasets / mlx-audio / opencv that
  # inference here never imports, and they cost ~1 GB of downloads.
  echo "==> installing mlx-vlm (LocateAnything branch, --no-deps)"
  UV_HTTP_TIMEOUT=180 uv pip install --python "$VENV/bin/python" --no-deps "$MLX_VLM_REF"
fi

export LA_MODEL="$MODEL"
echo "==> LocateAnything Studio  http://127.0.0.1:$PORT"
exec "$VENV/bin/python" -m uvicorn la_studio.server:app --host 127.0.0.1 --port "$PORT"
