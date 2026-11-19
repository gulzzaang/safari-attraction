# 사파리-어트랙션

Claude 가 박정욱의 실제 로그인된 사파리를 몰 수 있게 하는 로컬 TypeScript MCP 서버. 계속 떠 있는 `osascript -l JavaScript` 프로세스 하나로 사파리를 움직이고, Aside 브라우저의 `repl` 처럼 자바스크립트 한 덩어리로 열기 · 읽기 · 입력 · 클릭을 한다. 새 탭은 뒤쪽 탭으로 열려 사용자 화면을 가로채지 않는다. 서버가 끝나면 Claude 가 연 탭은 모두 닫힌다(사용자 탭은 건드리지 않는다).

## 필요한 것

- macOS, 사파리, Node 18 이상(플러그인으로 쓸 때). 소스에서 빌드 · 시험하려면 Node 20 이상.
- 사파리 설정 두 가지(처음 한 번):
  1. 사파리 ▸ 설정 ▸ 고급 ▸ **웹 개발자용 기능 보기** 켜기.
  2. 메뉴 막대 **개발** ▸ **Apple 이벤트의 JavaScript 허용** 켜기.
- 처음 쓸 때 macOS 가 「자동화」 허락을 묻는다(터미널이나 Claude 가 사파리를 제어해도 되는지). 허락해야 한다. 막혔다면 시스템 설정 ▸ 개인정보 보호 및 보안 ▸ 자동화에서 켠다.
- 막혔을 때는 `status` 도구를 먼저 부르면 무엇이 꺼져 있는지 한국어로 알려 준다.

## 설치 — Claude Code 플러그인(권장)

Claude Code 안에서 한 줄:

```
/plugin install safari-attraction --marketplace gulzzaang/safari-attraction
```

또는 두 줄로:

```
/plugin marketplace add gulzzaang/safari-attraction
/plugin install safari-attraction@safari-attraction
```

저장소가 비공개라 그 맥의 git 이 GitHub `gulzzaang` 으로 로그인돼 있어야 한다. 안 되면 저장소를 내려받은 폴더로 설치한다(GitHub 로그인 불필요):

```
/plugin marketplace add ~/Documents/safari-attraction
/plugin install safari-attraction@safari-attraction
```

플러그인은 `plugin/server.mjs`(부품을 한 파일로 묶은 서버)를 그 맥의 `node` 로 띄운다. 설치 뒤 새 세션부터 도구가 보인다. 아래 「직접 등록」으로 이미 등록한 맥이라면 같은 도구가 두 개 생기니 `claude mcp remove --scope user safari-attraction` 으로 하나를 지운다.

## 설치 — 소스에서 직접 등록(개발용)

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
- AI 창 크기와 `innerWidth` 는 사파리 창 최소 폭(약 336px)과 화면 크기에 묶인다.

## 개발

```sh
npm test                                   # 단위 시험(사파리 없이)
SAFARI_IT=1 npx vitest run test/integration/tabs.it.test.ts   # 통합 시험(진짜 사파리, 파일 하나씩)
```

`src/` 를 고치면 `npm run build` 로 `plugin/server.mjs` 도 다시 만들어 함께 커밋한다(플러그인은 설치할 때 빌드하지 않는다).

측정은 `npm run build && node dist/scripts/bench.js`(진짜 사파리를 쓴다. 자기가 연 탭 · AI 창만 열고 끝에 닫는다).

통합 시험은 자기가 연 탭에만 표시를 달아 열고 닫으며 사용자 탭은 건드리지 않는다. `spikes/` 에는 `.mcpb` 안에서 osascript 가 도는지 · 사파리 창 최소 폭을 재 보는 첫 시험이 들어 있다.
