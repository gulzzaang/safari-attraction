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

## 쓰는 법 (시험판 — 이 맥에서만)

- **열기 · 닫기**: ⌥⇧S(Option+Shift+S), 또는 메뉴 막대 아이콘. 옆 창은 사파리 앞 창 오른쪽 바깥에 붙고(자리가 없으면 안쪽에 겹침), 사파리 창이 움직이면 따라간다. 사파리가 뒤로 가면 숨는다 — 「고정」 을 켜면 안 숨는다.
- **모델**: 클로드(`claude -p`, sonnet) · 제미나이(`agy -p`, 구글 구독) · ChatGPT(`codex exec`). 각 CLI 에 로그인돼 있어야 한다. 앱은 로그인 셸의 PATH 로 CLI 를 찾는다.
- **웹 검색**: 클로드는 WebSearch · WebFetch 도구만 켜고, 제미나이는 질문 앞에 「웹에서 찾아서」 를 붙인다. ChatGPT 는 검색 없이 답한다고 먼저 알린다.
- **이 페이지 함께**: 지금 사파리 탭의 제목 · 주소 · 고른 글을 질문 앞에 붙인다.
- **멈춤 · 시간 상한**: 답이 오는 중에 「멈춤」, 180초가 넘으면 저절로 멈추고 한국어로 알린다.
- 대화는 앱 안에만 있고(이번 실행 동안), 사파리-어트랙션 기억 폴더에 쓰지 않는다. 작업 폴더는 `~/Library/Application Support/SafariAttractionApp/work`(빈 폴더).

## 맥 허락 창 (처음 한 번 — 맥 앞에서)

앱은 ad-hoc 서명이라 맥이 허락을 이 앱 이름으로 묻는다. **맥 앞에 있을 때 처음 써 보세요** — 아무도 안 누른 허락 창이 떠 있으면 그 질문은 창에서 멈춘다.

- **자동화(사파리 제어)**: 「이 페이지 함께」 · 옆 창 따라가기에 필요하다. 거절해도 대화는 된다(옆 창이 사파리를 못 따라가고, 페이지는 안 붙는다).
- **문서 폴더 접근**: 앱이 띄운 CLI 가 사용자 설정을 따라 문서 폴더(`~/Documents`)에 손대면 묻는다.
  - 클로드는 `--safe-mode` 로 띄워 사용자 훅 · 플러그인 · CLAUDE.md 를 불러오지 않으므로 묻지 않는다.
  - 제미나이(`agy`)는 세션만 MCP 서버를 끄는 옵션이 없어 `~/.gemini/config/mcp_config.json` 의 MCP 서버를 그대로 띄운다. 그중 문서 폴더 안에 있는 서버(예: 개발 중인 `~/Documents/safari-attraction/dist`)가 있으면 처음 한 번 묻는다. 한 번 답하면 다시 묻지 않는다. 「허용 안 함」 을 누르면 그 MCP 서버만 못 뜰 것으로 보는데, 그때도 답이 오는지는 아직 확인하지 못했다.

## 알려진 한계

- 이 맥에서만 돈다(서명 인증서 없음 · 공증 없음). 다른 맥으로 옮기려면 유료 개발자 계정이 필요하다.
- 제미나이 · ChatGPT 는 이어 묻기를 앞 대화를 질문에 붙여서 한다(클로드는 `--resume`).
- 조각 2(페이지 위 패널) 전까지는 사파리 안에서 부를 수 없다 — 옆 창 · 단축키만.
