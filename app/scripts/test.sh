#!/bin/zsh
# AppCore 시험 — 로컬 Swift 패키지(app/AppCore)를 swift test 로 돌린다.
set -euo pipefail
cd "$(dirname "$0")/../AppCore"
swift test --scratch-path ../.build/swiftpm
