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

> **아직 앱을 띄워 보는 확인은 안 했다.** 코드 · 단위 시험(203개) · 빌드까지만 끝났다. 옆 창 위치 · 따라가기 · 클로드 답 · 웹 검색 · 「이 페이지 함께」 · 허락 창은 박정욱이 맥 앞에 있을 때 확인한다. 아래는 그렇게 동작하도록 만든 내용이다.


- **열기 · 닫기**: ⌥⇧S(Option+Shift+S), 또는 메뉴 막대 아이콘. 옆 창은 사파리 앞 창 오른쪽 바깥에 붙고(자리가 없으면 안쪽에 겹침), 사파리 창이 움직이면 따라간다. 사파리가 뒤로 가면 숨는다 — 「고정」 을 켜면 안 숨는다.
- **모델**: 지금은 클로드(`claude -p`, sonnet)만 부른다(박정욱 11-23 「클로드만 기준으로잡고 다른 cli는 사용하지말고」). 제미나이(`agy`) · ChatGPT(`codex`) 코드는 남아 있지만 꺼 두었다 — `ModelKind.enabled` 에 더하면 다시 켜진다. `claude` 에 로그인돼 있어야 하고, 앱은 로그인 셸의 PATH 로 찾는다.
- **웹 검색**: 클로드에 WebSearch · WebFetch 도구만 켠다.
- **이 페이지 함께**: 지금 사파리 탭의 제목 · 주소 · 고른 글을 질문 앞에 붙인다.
- **멈춤 · 시간 상한**: 답이 오는 중에 「멈춤」, 180초가 넘으면 저절로 멈추고 한국어로 알린다.
- 대화는 앱 안에만 있고(이번 실행 동안), 사파리-어트랙션 기억 폴더에 쓰지 않는다. 작업 폴더는 `~/Library/Application Support/SafariAttractionApp/work`(빈 폴더).

## 맥 허락 창 (처음 한 번 — 맥 앞에서)

앱은 ad-hoc 서명이라 맥이 허락을 이 앱 이름으로 묻는다. **맥 앞에 있을 때 처음 써 보세요** — 아무도 안 누른 허락 창이 떠 있으면 그 질문은 창에서 멈춘다.

- **자동화(사파리 제어)**: 「이 페이지 함께」 · 옆 창 따라가기에 필요하다. 거절해도 대화는 된다(옆 창이 사파리를 못 따라가고, 페이지는 안 붙는다).
- **문서 폴더 접근**: 앱이 띄운 CLI 가 사용자 설정을 따라 문서 폴더(`~/Documents`)에 손대면 묻는다.
  - 클로드는 `--safe-mode` 로 띄워 사용자 훅 · 플러그인 · CLAUDE.md 를 불러오지 않게 했다. 터미널에서는 훅 0 · MCP 0 으로 구독 답 · 웹 검색이 되는 것을 확인했다(앱에서 띄운 확인은 아직).
  - 제미나이(`agy`)를 다시 켜면 조심: 세션만 MCP 서버를 끄는 옵션이 없어 `~/.gemini/config/mcp_config.json` 의 MCP 서버를 그대로 띄우고, 그중 문서 폴더 안에 있는 서버가 있으면 처음 한 번 묻는다.

## 알려진 한계

- 이 맥에서만 돈다(서명 인증서 없음 · 공증 없음). 다른 맥으로 옮기려면 유료 개발자 계정이 필요하다.
- 조각 2(페이지 위 패널) 전까지는 사파리 안에서 부를 수 없다 — 옆 창 · 단축키만.
