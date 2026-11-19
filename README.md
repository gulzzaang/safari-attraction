# 사파리-어트랙션

Claude 가 사용자의 실제 로그인된 사파리를 몰 수 있게 하는 로컬 TypeScript MCP 서버. 계속 떠 있는 `osascript -l JavaScript` 프로세스 하나로 사파리를 움직이고, Aside 브라우저의 `repl` 처럼 자바스크립트 한 덩어리로 열기 · 읽기 · 입력 · 클릭을 한다. 새 탭은 뒤쪽 탭으로 열려 사용자 화면을 가로채지 않는다. 서버가 끝나면 Claude 가 연 탭은 모두 닫힌다(사용자 탭은 건드리지 않는다).

macOS 와 사파리가 필요하다. Node 는 플러그인 · 홈브루(자동으로 깔림) · 소스 빌드 때만 쓴다(플러그인 Node 18 이상, 소스에서 빌드 · 시험은 Node 20 이상). `.mcpb` 는 Claude 앱이 가진 Node 를 쓴다.

## 설치

내 쓰임에 맞는 길 하나만 고른다. 세 길 모두 같은 서버(`repl` · `status` 도구)를 깐다.

| 이런 분께 | 길 |
| --- | --- |
| Claude Code 를 쓴다 | 플러그인(한 줄) |
| 터미널은 쓸 줄 안다(Claude Code · Claude 앱 둘 다 연결하고 싶다) | 홈브루(세 줄) |
| 터미널이 낯설다(Claude 앱만 쓴다) | `.mcpb` 파일(더블클릭) |

저장소는 지금 비공개다. 플러그인과 홈브루 길은 그 맥의 git · GitHub 로그인이 `gulzzaang` 저장소에 접근할 수 있어야 한다. `.mcpb` 는 파일 하나라 그냥 전달하면 된다.

### 길 1. Claude Code 플러그인

Claude Code 안에서 한 줄:

```
/plugin install safari-attraction --marketplace gulzzaang/safari-attraction
```

또는 두 줄로:

```
/plugin marketplace add gulzzaang/safari-attraction
/plugin install safari-attraction@safari-attraction
```

GitHub 로그인이 안 돼 있으면 저장소를 내려받은 폴더로 설치한다(GitHub 로그인 불필요):

```
/plugin marketplace add ~/Documents/safari-attraction
/plugin install safari-attraction@safari-attraction
```

플러그인은 `plugin/server.mjs`(부품을 한 파일로 묶은 서버)를 그 맥의 `node` 로 띄운다(Node 18 이상). 설치 뒤 새 세션부터 도구가 보인다.

### 길 2. 홈브루

```sh
brew tap gulzzaang/safari-attraction https://github.com/gulzzaang/safari-attraction
brew install safari-attraction
safari-attraction setup
```

`setup` 이 Claude Code 와 Claude 앱(데스크톱) 설정에 `safari-attraction` 을 등록한다. 설정 파일을 고치기 전에 같은 폴더에 `…bak-<날짜시각>` 사본을 남기고, 우리 항목 말고는 건드리지 않는다. 먼저 보고 싶으면 `safari-attraction setup --dry-run`(아무것도 쓰지 않고 할 일만 출력), 한쪽만 하려면 `--no-claude-code` 또는 `--no-desktop`. 플러그인이 이미 깔려 있으면 Claude Code 쪽은 건너뛴다. 등록 경로는 `$(brew --prefix)/opt/safari-attraction/bin/safari-attraction` 이라 `brew upgrade` 뒤에도 그대로 살아 있다. 등록한 뒤 Claude 를 새로 시작한다.

### 길 3. Claude 앱 확장(`.mcpb`)

1. 이 저장소의 GitHub 릴리스 페이지(v0.1.0)에서 `safari-attraction-0.1.0.mcpb` 를 받는다(받아서 전달받아도 된다).
2. 파일을 더블클릭하면 Claude 앱이 열리며 설치 창이 뜬다. **「설치」** 를 누른다.
3. Claude 앱을 새로 시작하면 도구가 보인다.

### 공통 준비(처음 한 번)

길과 상관없이 필요하다.

1. 사파리 ▸ 설정 ▸ 고급 ▸ **웹 개발자용 기능 보기** 켜기.
2. 메뉴 막대 **개발** ▸ **Apple 이벤트의 JavaScript 허용** 켜기.
3. 처음 쓸 때 macOS 가 「자동화」 허락(터미널이나 Claude 가 사파리를 제어해도 되는지)을 묻는다. 허락해야 한다. 막혔다면 시스템 설정 ▸ 개인정보 보호 및 보안 ▸ 자동화에서 켠다.
4. 화면 찍기(`page.screenshot()`)를 쓸 때만: 아래 「화면 기록 권한」.

### 점검

- Claude 에게 `status` 도구를 불러 보라고 하면 무엇이 꺼져 있는지 한국어로 알려 준다.
- 터미널에서는 `safari-attraction doctor`(홈브루로 깐 경우). 모두 준비됐으면 0, 아니면 1 로 끝난다. 버전은 `safari-attraction --version`.

### 같은 도구가 두 번 보일 때

두 길 이상으로 깔면 `repl` · `status` 가 두 벌 보인다. 하나만 남기고 지운다.

| 지울 것 | 방법 |
| --- | --- |
| `setup` 이나 직접 등록한 Claude Code 연결 | `claude mcp remove --scope user safari-attraction` |
| 플러그인 | Claude Code 안에서 `/plugin uninstall safari-attraction` |
| `.mcpb` 확장 | Claude 앱 ▸ 설정 ▸ 확장에서 사파리-어트랙션을 지운다 |

`safari-attraction setup` 은 Claude Code 에 플러그인이 이미 있으면 등록하지 않는 식으로 겹침을 피하지만, 플러그인을 나중에 깔면 겹칠 수 있다. Claude 앱 설정에 `setup` 으로 등록한 항목과 `.mcpb` 가 겹칠 때는 `claude_desktop_config.json` 의 `safari-attraction` 항목을 지우거나 확장을 지운다.

### 소스에서 직접 등록(개발용)

```sh
npm install
npm run build        # dist/ 와 plugin/server.mjs 를 함께 만든다
claude mcp add --scope user safari-attraction -- <node 절대경로> <저장소 경로>/dist/src/index.js
```

`<node 절대경로>` 는 `which node` 로 확인한다(Node 20 이상). 등록한 뒤 새 세션부터 도구가 보인다.

## 도구 두 개

- `repl` — 사파리를 자바스크립트로 조작한다. `openTab(url)`, `attachActiveBrowserTab()`, `snapshot()`, `page.locator(...).click()/.fill()`, `page.evaluate(...)`, `fetch(url)` 등. 최상위 `await` 가 되고 `const` · 함수는 다음 호출에도 남는다. 값은 `console.log` 로 찍어야 보인다. 자세한 사용법은 도구 설명에 들어 있다. 계획 2에서 아래 기능이 더해졌다.
  - **AI 창** — `openAiWindow(url, {width, height})` 가 Claude 전용 사파리 창을 사용자 창 맨 뒤에 열고(앞 앱을 안 바꾼다) 그 안의 탭을 돌려준다. `page.setViewportSize({width, height})` 로 휴대폰 폭(390×844 등)을 맞춘다. 실제 크기를 돌려주고, 사파리 창은 약 336px 보다 좁게 못 줄이며 화면 높이가 작으면 높이는 그만큼만 나온다(이 개발 맥은 안쪽 높이가 약 795px 에서 멈춘다). 백그라운드 탭의 `innerWidth` 는 그 탭이 앞에 보일 때까지 늦게 바뀔 수 있다.
  - **찍기** — `page.screenshot()` 이 AI 창 전체(주소창 포함)를 PNG(긴 변 1568px 이하)로 찍고, `display(buf)` 로 결과에 붙인다(한 호출 4장까지). `useAiWindow(id)` 로 지정한 창에서는 찍을 때 그 창의 보이는 탭이 찍는 페이지로 바뀌고 되돌리지 않는다. AI 창은 사용자 창 뒤에 있어 사파리가 그 페이지를 숨김으로 보고하므로, 찍을 때마다 그리기를 최대 1초쯤 기다린다(화면 기록 권한이 있는 맥에서 다시 확인할 것).
  - **창 고르기** — `listWindows()` 가 열린 창(`id`, 현재 탭 제목, 탭 수, 크기, AI 창 · 작업 창 여부)을 보여 주고, `useWindow(id)` 로 `openTab` 이 열릴 창(그 창의 프로필을 따른다)을, `useAiWindow(id)` 로 이미 열어 둔 창을 AI 창으로 고른다. 사용자 창은 닫지 않는다.
  - **깊은 읽기** — `snapshot()` 이 열린 shadow DOM 과 같은 사이트 iframe 안쪽까지 읽는다.
- `status` — 빠진 준비를 한국어로 점검한다: 사파리 실행, 자동화 허락, 「Apple 이벤트의 JavaScript 허용」, 화면 기록(찍기용) 네 가지를 ✓ / ✗ / ? 로 보여 주고 고칠 곳을 알려 준다. 빈 탭을 잠깐 열었다 닫는다.

## 화면 기록 권한(찍기용)

`page.screenshot()` 은 macOS 의 화면 기록 권한이 있어야 한다. 시스템 설정 ▸ 개인정보 보호 및 보안 ▸ **화면 및 시스템 오디오 녹음** 에서 Claude 를 돌리는 앱(터미널 · Claude 앱 등)을 켜고, 그 앱을 다시 시작한다. 없으면 찍기가 `SCREEN_CAPTURE_DENIED` 안내 오류를 내고 다른 기능은 그대로 된다. 화면이 잠겨 있어도 찍지 못한다.

## 알려진 한계

- `snapshot()` 은 닫힌 shadow root 와 다른 사이트(또는 sandbox 된) iframe 안쪽을 읽지 못한다. 그런 곳은 한 줄로만 보이고 안쪽은 읽지 않는다. 그 안에서 Enter 로 제출해 이동하는 것은 이동으로 감지되지 않을 수 있다.
- `page.evaluate` 는 함수 하나나 식 하나만 받는다(여러 문장은 함수로 감싼다). 결과는 JSON 으로 오가서 DOM · 함수는 돌려받지 못하고, 바깥 변수는 못 쓰니 인자로 넘긴다.
- `fetch` 는 현재 `page` 안에서 돌아 그 페이지의 쿠키로 나가고 CORS · CSP 를 따른다. 돌려주는 값은 `{status, ok, statusText, url, headers(보통 객체), text(), json()}` 모양이다.
- `await` 뒤에서 이벤트 루프를 막는 코드(예: `await x; while (true) {}`)는 서버를 멈출 수 있다. 쓰지 않는다.
- 입력 · 클릭은 진짜 마우스 · 키보드가 아니라 페이지 안 이벤트로 보내진다.
- 사파리 스크립트로는 개인정보 보호 창과 일반 창을 구별할 수 없어 맨 앞 창을 그대로 쓴다. 개인정보 보호 창이 맨 앞이면 거기에 탭이 열릴 수 있다.
- 서버가 정리 단계를 거치기 전에 강제로 죽으면(SIGKILL 등) Claude 가 연 탭 · 창이 그대로 남을 수 있다. 그럴 땐 직접 닫는다.
- AI 창 크기와 `innerWidth` 는 사파리 창 최소 폭(약 336px)과 화면 크기에 묶인다.

## 개발

```sh
npm test                                   # 단위 시험(사파리 없이)
SAFARI_IT=1 npx vitest run test/integration/tabs.it.test.ts   # 통합 시험(진짜 사파리, 파일 하나씩)
```

`src/` 를 고치면 `npm run build` 로 `plugin/server.mjs` 도 다시 만들어 함께 커밋한다(플러그인은 설치할 때 빌드하지 않는다).

측정은 `npm run build && node dist/scripts/bench.js`(진짜 사파리를 쓴다. 자기가 연 탭 · AI 창만 열고 끝에 닫는다).

통합 시험은 자기가 연 탭에만 표시를 달아 열고 닫으며 사용자 탭은 건드리지 않는다. `spikes/` 에는 `.mcpb` 안에서 osascript 가 도는지 · 사파리 창 최소 폭을 재 보는 첫 시험이 들어 있다.

## 새 버전 내기(관리자용)

1. `src/version.ts` 의 `VERSION` 을 올리고, `test/unit/version-sync.test.ts` 가 확인하는 자리를 모두 같은 값으로 맞춘다: `package.json` · `package-lock.json`(루트 두 곳) · `plugin/.claude-plugin/plugin.json` · `.claude-plugin/marketplace.json` · `mcpb/manifest.json` · `Formula/safari-attraction.rb`(`tag: "vX.Y.Z"`).
2. `npm test` 로 버전 맞춤 시험을 포함한 단위 시험을 통과시킨다.
3. `npm run build` (`plugin/server.mjs` 갱신) → `npm run pack:mcpb` (`out-mcpb/safari-attraction-X.Y.Z.mcpb` 생성).
4. `npm run check:bundle` 로 커밋한 `plugin/server.mjs` · `plugin/jxa/host.js` 가 지금 `src/` 에서 다시 만든 것과 같은지 확인한다(다르면 3번을 다시 한다).
5. 커밋 → 태그 `vX.Y.Z` → `main` 과 태그 push.
6. GitHub 릴리스를 만들고 `.mcpb` 파일을 붙인다.
