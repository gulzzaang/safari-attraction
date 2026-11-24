#!/bin/zsh
# 앱 빌드 — Xcode 없이 SwiftPM 으로 빌드하고 .app 묶음을 직접 조립한다(ad-hoc 서명). 만들기만 하고 띄우지 않는다.
# 결과: app/.build/SafariAttractionApp.app
# 개발용 열쇠(safariattraction:// 주소 · dev-last.json 기록)는 `DEV=1 app/scripts/build.sh` 로 만든 빌드에만 들어간다.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$APP_DIR/.build"
APP="$BUILD/SafariAttractionApp.app"

EXTRA=()
URL_TYPES=""
SCRATCH="$BUILD/swiftpm-app"
if [[ "${DEV:-}" == "1" ]]; then
  EXTRA=(-Xswiftc -DSA_DEV_HOOKS)
  SCRATCH="$BUILD/swiftpm-app-dev"
  URL_TYPES='	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.gulzzaang.SafariAttractionApp</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>safariattraction</string>
			</array>
		</dict>
	</array>'
  echo "DEV=1 — 개발용 열쇠가 들어간 빌드(배포용 아님)"
fi

cd "$APP_DIR/SafariAttractionApp"
swift build -c release --scratch-path "$SCRATCH" "${EXTRA[@]}"
BIN="$(swift build -c release --scratch-path "$SCRATCH" "${EXTRA[@]}" --show-bin-path)/SafariAttractionApp"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SafariAttractionApp"

# 서버 묶음(일 맡기기가 클로드에게 붙이는 MCP 서버)을 앱 안에 넣는다 — 문서 폴더의 dist 가 아니라 앱 안에서 띄워
# 맥의 문서 폴더 허락 창을 피한다. 서명 전에 넣는다(서명이 이 파일들까지 봉인한다).
REPO_ROOT="$(cd "$APP_DIR/.." && pwd)"
BUNDLE_RES="$APP/Contents/Resources/safari-attraction"
BUNDLE_FILES=(run.sh server.mjs jxa/host.js)
for f in "${BUNDLE_FILES[@]}"; do
  if [[ ! -f "$REPO_ROOT/plugin/$f" ]]; then
    echo "빌드 실패: 서버 묶음 파일이 없어요 — $REPO_ROOT/plugin/$f (plugin/ 폴더가 온전한지 확인하세요 — server.mjs 가 없으면 저장소 루트에서 npm run build)" >&2
    exit 1
  fi
done
# 묶음 신선도 — plugin/server.mjs 가 src/ 에서 다시 묶은 것과 같은지(node 가 있을 때). 옛 묶음을 앱에 넣지 않으려는 확인이다.
if command -v node >/dev/null 2>&1; then
  if ! (cd "$REPO_ROOT" && sh scripts/check-bundle.sh); then
    echo "빌드 실패: plugin/server.mjs 가 src/ 와 달라요 — npm run build 먼저" >&2
    exit 1
  fi
else
  echo "경고: node 가 없어 plugin/server.mjs 가 src/ 와 같은지 확인하지 못했어요(저장소 루트에서 npm run check:bundle)" >&2
fi
mkdir -p "$BUNDLE_RES/jxa"
cp "$REPO_ROOT/plugin/run.sh" "$BUNDLE_RES/run.sh"
cp "$REPO_ROOT/plugin/server.mjs" "$BUNDLE_RES/server.mjs"
cp "$REPO_ROOT/plugin/jxa/host.js" "$BUNDLE_RES/jxa/host.js"
chmod +x "$BUNDLE_RES/run.sh"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.gulzzaang.SafariAttractionApp</string>
	<key>CFBundleName</key>
	<string>SafariAttractionApp</string>
	<key>CFBundleDisplayName</key>
	<string>사파리-어트랙션</string>
	<key>CFBundleExecutable</key>
	<string>SafariAttractionApp</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSAppleEventsUsageDescription</key>
	<string>지금 보고 있는 사파리 탭의 주소 · 제목을 질문에 붙이고, 창 옆에 붙기 위해 사파리 창 위치를 읽어요.</string>
${URL_TYPES}
</dict>
</plist>
PLIST

plutil -lint "$APP/Contents/Info.plist"
codesign --force -s - "$APP"
codesign --verify --verbose=2 "$APP"

# 끝 확인 — 서명한 뒤에도 서버 묶음 세 파일이 앱 안에 있고 run.sh 가 실행 가능한지.
for f in "${BUNDLE_FILES[@]}"; do
  if [[ ! -s "$BUNDLE_RES/$f" ]]; then
    echo "빌드 실패: 앱 안에 서버 묶음 파일이 없어요 — $BUNDLE_RES/$f" >&2
    exit 1
  fi
done
if [[ ! -x "$BUNDLE_RES/run.sh" ]]; then
  echo "빌드 실패: 앱 안의 run.sh 가 실행 가능하지 않아요 — $BUNDLE_RES/run.sh" >&2
  exit 1
fi
echo "서버 묶음 확인:"
ls -l "$BUNDLE_RES" "$BUNDLE_RES/jxa"
echo "앱 만듦: $APP"
