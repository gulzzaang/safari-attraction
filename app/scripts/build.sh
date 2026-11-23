#!/bin/zsh
# 앱 빌드 — Xcode 없이 SwiftPM 으로 빌드하고 .app 묶음을 직접 조립한다(ad-hoc 서명).
# 결과: app/.build/SafariAttractionApp.app
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$APP_DIR/.build"
APP="$BUILD/SafariAttractionApp.app"

cd "$APP_DIR/SafariAttractionApp"
swift build -c release --scratch-path "$BUILD/swiftpm-app"
BIN="$(swift build -c release --scratch-path "$BUILD/swiftpm-app" --show-bin-path)/SafariAttractionApp"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SafariAttractionApp"

cat > "$APP/Contents/Info.plist" <<'PLIST'
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
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.gulzzaang.SafariAttractionApp</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>safariattraction</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST

plutil -lint "$APP/Contents/Info.plist"
codesign --force -s - "$APP"
codesign --verify --verbose=2 "$APP"
echo "앱 만듦: $APP"
