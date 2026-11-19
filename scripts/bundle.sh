#!/bin/sh
# src/index.ts 를 하나의 파일로 묶는다. 사용: sh scripts/bundle.sh <내보낼 파일>
# `npm run bundle`(plugin/server.mjs 만들기)과 `npm run check:bundle`(같은 묶음인지 비교)이 같은 옵션을 쓰게 한 곳에 둔다.
set -eu
cd "$(dirname "$0")/.."
OUT="${1:?내보낼 파일 경로가 필요해요}"
exec npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node18 --minify --keep-names --legal-comments=eof \
  --banner:js='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' \
  --outfile="$OUT" --log-level=warning
