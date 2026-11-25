#!/bin/zsh
# 앱 빌드 — Xcode 없이 SwiftPM 으로 빌드하고 .app 묶음을 직접 조립한다(ad-hoc 서명). 만들기만 하고 띄우지 않는다.
# 결과: app/.build/SafariAttractionApp.app — 그리고 문서 폴더 밖인 ~/Applications/SafariAttractionApp.app 으로 복사한다(거기서 여세요:
# 문서 폴더 안의 앱을 열면 맥이 문서 폴더 허락을 앱 이름으로 묻는 일이 잦다). 복사가 실패해도 빌드는 성공이고 경고만 한다.
# 개발용 열쇠(safariattraction:// 주소 · dev-last.json 기록)는 `DEV=1 app/scripts/build.sh` 로 만든 빌드에만 들어간다.
# 사파리 확장(페이지 위 패널)은 swiftc 로 따로 빌드해 Contents/PlugIns/SafariAttractionExtension.appex 로 넣는다(Xcode 없이 손 조립 —
# 안쪽 appex 를 먼저 서명하고 그다음 앱을 서명한다, --deep 은 쓰지 않는다). ~/Applications 로 복사한 뒤 `pluginkit -a` 로 등록한다(실패해도 빌드는 성공).
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

# ── 사파리 확장(appex) 조립 ──────────────────────────────────────────────────
# Xcode 프로젝트 없이: swiftc(-e _NSExtensionMain) → Info.plist 손으로 → Resources 에 확장 JS · manifest 복사 → ext.entitlements 로 서명.
# 앱 서명보다 먼저(안쪽부터) 한다. 아이콘은 만들 수 있을 때만 넣는다(실패해도 빌드는 계속, 아이콘 없이 사파리 기본 모양).
EXT_SRC="$APP_DIR/extension"
EXT_NAME="SafariAttractionExtension"
EXT_EXEC="SafariAttractionExt"
EXT_ID="com.gulzzaang.SafariAttractionApp.Extension"
APPEX="$APP/Contents/PlugIns/$EXT_NAME.appex"
EXT_BUILD="$BUILD/ext"
EXT_RUNTIME_FILES=(manifest.json background.js content.js notify-hook.js panel.css lib/page.js lib/text.js lib/stream.js lib/cards.js lib/bridge.js lib/alerts.js)
for f in "${EXT_RUNTIME_FILES[@]}" Handler/SafariWebExtensionHandler.swift ext.entitlements; do
  if [[ ! -f "$EXT_SRC/$f" ]]; then
    echo "빌드 실패: 확장 파일이 없어요 — $EXT_SRC/$f" >&2
    exit 1
  fi
done
rm -rf "$EXT_BUILD"
mkdir -p "$EXT_BUILD" "$APPEX/Contents/MacOS" "$APPEX/Contents/Resources/lib"
SDK_PATH="$(xcrun --show-sdk-path)"
swiftc -O -module-name "$EXT_EXEC" -parse-as-library -emit-executable \
  -sdk "$SDK_PATH" -target "$(uname -m)-apple-macos14.0" \
  -framework Foundation -framework SafariServices \
  -Xlinker -e -Xlinker _NSExtensionMain -Xlinker -random_uuid \
  "$EXT_SRC/Handler/SafariWebExtensionHandler.swift" -o "$APPEX/Contents/MacOS/$EXT_EXEC"
for f in "${EXT_RUNTIME_FILES[@]}"; do
  cp "$EXT_SRC/$f" "$APPEX/Contents/Resources/$f"
done

# 아이콘(단색 PNG) — 되면 넣고 manifest 에 적는다. 안 되면 건너뛴다.
make_icons() {
  swiftc -O -sdk "$SDK_PATH" -o "$EXT_BUILD/make-icons" "$APP_DIR/scripts/make-icons.swift" \
    && "$EXT_BUILD/make-icons" "$EXT_BUILD/icons" \
    && [[ -s "$EXT_BUILD/icons/icon-128.png" ]]
}
if make_icons; then
  mkdir -p "$APPEX/Contents/Resources/images"
  cp "$EXT_BUILD"/icons/icon-*.png "$APPEX/Contents/Resources/images/"
  ICONS_JSON='{"16":"images/icon-16.png","32":"images/icon-32.png","48":"images/icon-48.png","64":"images/icon-64.png","96":"images/icon-96.png","128":"images/icon-128.png","256":"images/icon-256.png"}'
  ACTION_ICONS_JSON='{"16":"images/icon-16.png","32":"images/icon-32.png","48":"images/icon-48.png"}'
  if plutil -insert icons -json "$ICONS_JSON" "$APPEX/Contents/Resources/manifest.json" \
     && plutil -insert action.default_icon -json "$ACTION_ICONS_JSON" "$APPEX/Contents/Resources/manifest.json"; then
    echo "확장 아이콘 넣음"
  else
    echo "경고: 확장 manifest 에 아이콘을 적지 못했어요 — 아이콘 없이 가요" >&2
    cp "$EXT_SRC/manifest.json" "$APPEX/Contents/Resources/manifest.json"
    rm -rf "$APPEX/Contents/Resources/images"
  fi
else
  echo "경고: 확장 아이콘을 만들지 못했어요 — 아이콘 없이 가요(사파리 기본 모양)" >&2
  rm -rf "$APPEX/Contents/Resources/images"
fi
# manifest 가 올바른 JSON 인지(아이콘을 적은 뒤에도) 확인.
plutil -convert json -o /dev/null "$APPEX/Contents/Resources/manifest.json" \
  || { echo "빌드 실패: 확장 manifest.json 이 올바른 JSON 이 아니에요" >&2; exit 1; }

cat > "$APPEX/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${EXT_ID}</string>
	<key>CFBundleName</key>
	<string>${EXT_NAME}</string>
	<key>CFBundleDisplayName</key>
	<string>사파리-어트랙션</string>
	<key>CFBundleExecutable</key>
	<string>${EXT_EXEC}</string>
	<key>CFBundlePackageType</key>
	<string>XPC!</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.Safari.web-extension</string>
		<key>NSExtensionPrincipalClass</key>
		<string>${EXT_EXEC}.SafariWebExtensionHandler</string>
	</dict>
</dict>
</plist>
PLIST
plutil -lint "$APPEX/Contents/Info.plist"
# 안쪽(appex)부터 서명 — 샌드박스 · 네트워크(내 컴퓨터 127.0.0.1) · 연결 파일 한 개 읽기만 허락.
codesign --force -s - --entitlements "$EXT_SRC/ext.entitlements" --options runtime "$APPEX"
codesign --verify --strict --verbose=2 "$APPEX"
echo "확장 만듦: $APPEX"

# 앱 서명(안쪽 appex 는 위에서 이미 서명했다 — --deep 안 씀).
codesign --force -s - "$APP"
codesign --verify --strict --verbose=2 "$APP"

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

# 문서 폴더 밖으로 복사 — ~/Applications/SafariAttractionApp.app (있으면 바꿔치기). 실패해도 위 빌드는 성공으로 둔다.
INSTALL_DIR="$HOME/Applications"
INSTALLED="$INSTALL_DIR/SafariAttractionApp.app"
# 바꿔치기 전에 옛 확장 등록을 풀어 둔다(같은 경로에 다시 깔 때 맥이 옛 등록과 새 것을 헷갈려 새 것을 목록에서 빼는 일을 막는다). 우리 확장만 푼다.
if [[ -d "$INSTALLED/Contents/PlugIns/$EXT_NAME.appex" ]]; then
  pluginkit -r "$INSTALLED/Contents/PlugIns/$EXT_NAME.appex" >/dev/null 2>&1 || true
fi
if mkdir -p "$INSTALL_DIR" \
   && rm -rf "$INSTALLED" \
   && ditto "$APP" "$INSTALLED" \
   && codesign --verify --verbose=2 "$INSTALLED"; then
  echo "여기서 여세요: ~/Applications/SafariAttractionApp.app"
  # 사파리 확장 등록 — 복사한 앱 안의 appex 를 맥(pluginkit)에 알린다. 실패해도 빌드는 성공(앱을 한 번 열면 맥이 알아보기도 한다).
  # 같은 자리에 앱을 바꿔치기하면 옛 앱이 지워진 것을 맥이 뒤늦게 알아채 방금 한 등록을 풀어 버릴 수 있다 —
  # 그래서 등록한 뒤 잠깐 기다려 목록에 남아 있는지 보고, 없으면 다시 등록한다(세 번까지).
  EXT_REGISTERED=0
  for attempt in 1 2 3; do
    pluginkit -a "$INSTALLED/Contents/PlugIns/$EXT_NAME.appex" || echo "경고: pluginkit -a 가 실패했어요(시도 $attempt)" >&2
    sleep 3
    # 목록을 먼저 변수에 담고 본다(pipefail 아래 `| grep -q` 는 grep 이 일찍 끝나 SIGPIPE 로 「없음」 으로 잘못 보일 수 있다).
    EXT_LISTED="$(pluginkit -m -i "$EXT_ID" 2>/dev/null || true)"
    if [[ "$EXT_LISTED" == *"$EXT_ID"* ]]; then EXT_REGISTERED=1; break; fi
  done
  if [[ "$EXT_REGISTERED" == "1" ]]; then
    echo "사파리 확장 등록함 — 사파리 설정 → 확장 → 「사파리-어트랙션」 (켜는 법은 app/README.md)"
  else
    echo "경고: 사파리 확장이 목록(pluginkit -m)에 안 보여요 — 앱을 한 번 열거나 build.sh 를 다시 돌려 보세요. 빌드는 성공했어요." >&2
  fi
else
  echo "경고: ~/Applications 로 복사하지 못했어요 — 빌드는 성공했어요($APP). 문서 폴더 밖에서 열려면 직접 복사하세요: ditto \"$APP\" \"$INSTALLED\"" >&2
fi
