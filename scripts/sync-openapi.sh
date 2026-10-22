#!/usr/bin/env bash
# Refresh openapi/plugin-v1.json -- the plugin plane's contract -- and the types generated from it.
#
#   scripts/sync-openapi.sh                        # from korsi-core/korsi-api beside korsi-plugins
#   scripts/sync-openapi.sh https://acme.korsi.ai  # from a running Korsi (/plugin/v1/openapi.json)
#
# Then run both SDKs' tests: a route Korsi added or removed fails the contract tests until the
# clients have it (python/tests/test_contract.py, packages/plugin/test/client.test.ts).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/openapi/plugin-v1.json"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [[ $# -ge 1 ]]; then
  curl -fsS "${1%/}/plugin/v1/openapi.json" -o "$tmp"
else
  api="${KORSI_API_DIR:-$root/../../korsi-core/korsi-api}"
  (cd "$api" && uv run --frozen python - >"$tmp") <<'PY'
import json, sys
from fastapi.openapi.utils import get_openapi
from korsi_api.contracts.plugins import PLUGIN_API
from korsi_api.domains.plugins import plane

router = plane.build_plugin_plane_router()
json.dump(
    get_openapi(title="Korsi plugin API", version=PLUGIN_API, description=plane.__doc__,
                routes=router.routes),
    sys.stdout,
)
PY
fi

python3 - "$tmp" "$target" <<'PY'
import json, sys
document = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump(document, out, ensure_ascii=False, indent=2)
PY
python3 "$root/scripts/generate_models.py"
echo "openapi/plugin-v1.json: plugin API $(python3 -c "import json;print(json.load(open('$target'))['info']['version'])")"
