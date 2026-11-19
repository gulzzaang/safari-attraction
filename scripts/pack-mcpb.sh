#!/bin/sh
# Claude 데스크톱 확장(.mcpb)을 만든다: 빌드 → build/mcpb 에 필요한 것만 복사 → validate → pack.
# 결과: out-mcpb/safari-attraction-<버전>.mcpb (git 에 안 넣고 릴리스에 붙인다)
set -eu
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./mcpb/manifest.json').version")

npm run build

rm -rf build/mcpb
mkdir -p build/mcpb/jxa out-mcpb
cp mcpb/manifest.json build/mcpb/manifest.json
cp plugin/server.mjs build/mcpb/server.mjs
cp plugin/jxa/host.js build/mcpb/jxa/host.js

npx -y @anthropic-ai/mcpb@2.1.2 validate build/mcpb/manifest.json
npx -y @anthropic-ai/mcpb@2.1.2 pack build/mcpb "out-mcpb/safari-attraction-$VERSION.mcpb"
echo "만들었다: out-mcpb/safari-attraction-$VERSION.mcpb"
