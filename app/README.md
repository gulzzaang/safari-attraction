# 사파리-어트랙션 앱 (조각 1)

사파리 옆에 붙는 Claude 옆 창 앱. MCP 서버(`src/` · `plugin/` · `mcpb/`)와는 따로다.

- `AppCore/` — 순수 로직 Swift 패키지(`AppCore` 라이브러리 + `AppCoreTests`). Apple 프레임워크만 쓴다.
- `SafariAttractionApp/` — 앱 실행 파일 패키지(`SafariAttractionApp`, `AppCore` 를 경로로 참조). 메뉴 막대 아이콘만 있는 앱(Dock 아이콘 없음).
- `extension/` — 사파리 확장 씨앗(`manifest.json` · `background.js`), 조각 2 에서 채운다.

## 빌드 · 시험 · 실행 (Xcode 없이)

```sh
app/scripts/build.sh   # swift build -c release → app/.build/SafariAttractionApp.app 조립 + ad-hoc 서명
app/scripts/test.sh    # AppCore 시험(swift test)
open -g app/.build/SafariAttractionApp.app                     # 앞으로 안 나오게 띄우기
osascript -e 'quit app id "com.gulzzaang.SafariAttractionApp"'  # 끄기
```

`app/.build/` 는 git 에 올리지 않는다.

## 조각 2(사파리 확장) 전에

사파리 확장 대상은 Xcode 도구(`safari-web-extension-converter` · `xcodebuild`)가 필요하다. 이 맥은 Xcode 첫 실행 구성요소가 안 깔려 있어서, 먼저 터미널에서 `sudo xcodebuild -runFirstLaunch` 를 한 번 실행하거나 Xcode 를 한 번 열어 설치를 마쳐야 한다.
