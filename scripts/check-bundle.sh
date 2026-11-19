#!/bin/sh
# 커밋된 plugin/server.mjs · plugin/jxa/host.js 가 지금 src/ 에서 다시 만든 것과 같은지 본다(릴리스 전에 돌린다).
# 다르면 `npm run build` 를 하고 함께 커밋해야 한다.
set -eu
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
sh scripts/bundle.sh "$TMP/server.mjs"
fail=0
cmp -s "$TMP/server.mjs" plugin/server.mjs || { echo "plugin/server.mjs 가 src/ 와 달라요 — npm run build 후 함께 커밋하세요" >&2; fail=1; }
cmp -s src/driver/jxa/host.js plugin/jxa/host.js || { echo "plugin/jxa/host.js 가 src/driver/jxa/host.js 와 달라요 — npm run build 후 함께 커밋하세요" >&2; fail=1; }
[ "$fail" = 0 ] && echo "묶음이 src/ 와 같아요"
exit "$fail"
