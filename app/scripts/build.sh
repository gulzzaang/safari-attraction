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
echo "앱 만듦: $APP"
