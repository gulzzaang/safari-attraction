#!/bin/zsh
# 시험 — 사파리 확장의 순수 JS(node --test, node 가 없으면 건너뜀) 다음 AppCore(로컬 Swift 패키지, swift test). 한 번에 하나씩.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  node --test "$APP_DIR/extension/test"
else
  echo "알림: node 가 없어 확장 JS 시험(node --test app/extension/test)은 건너뛰어요" >&2
fi
cd "$APP_DIR/AppCore"
swift test --scratch-path ../.build/swiftpm
