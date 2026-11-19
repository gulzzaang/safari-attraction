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

- `repl` — 사파리를 자바스크립트로 조작한다. `openTab(url)`, `attachActiveBrowserTab()`, `snapshot()`, `page.locator(...).click()/.fill()`, `page.evaluate(...)`, `fetch(url)` 등. 최상위 `await` 가 되고 `const` · 함수는 다음 호출에도 남는다. 값은 `console.log` 로 찍어야 보인다. 자세한 사용법은 도구 설명에 들어 있다.
- `status` — 사파리가 켜져 있는지, 창 수, 「Apple 이벤트의 JavaScript 허용」과 자동화 허락 상태를 알려 준다. 빈 탭을 잠깐 열었다 닫는다.

## 알려진 한계

- `snapshot()` 은 iframe 안과 shadow DOM 안을 읽지 못한다.
- `page.evaluate` 는 함수 하나나 식 하나만 받는다(여러 문장은 함수로 감싼다). 결과는 JSON 으로 오가서 DOM · 함수는 돌려받지 못하고, 바깥 변수는 못 쓰니 인자로 넘긴다.
- `fetch` 는 현재 `page` 안에서 돌아 그 페이지의 쿠키로 나가고 CORS · CSP 를 따른다. 돌려주는 값은 `{status, ok, statusText, url, headers(보통 객체), text(), json()}` 모양이다.
- `await` 뒤에서 이벤트 루프를 막는 코드(예: `await x; while (true) {}`)는 서버를 멈출 수 있다. 쓰지 않는다.
- 입력 · 클릭은 진짜 마우스 · 키보드가 아니라 페이지 안 이벤트로 보내진다.
- 사파리 스크립트로는 개인정보 보호 창과 일반 창을 구별할 수 없어 맨 앞 창을 그대로 쓴다. 개인정보 보호 창이 맨 앞이면 거기에 탭이 열릴 수 있다.
- 화면 찍기 · `display()` 는 아직 없다(계획 2에서 AI 전용 창 방식으로 만든다).

## 개발

```sh
npm test                                   # 단위 시험(사파리 없이)
SAFARI_IT=1 npx vitest run test/integration/tabs.it.test.ts   # 통합 시험(진짜 사파리, 파일 하나씩)
```

`src/` 를 고치면 `npm run build` 로 `plugin/server.mjs` 도 다시 만들어 함께 커밋한다(플러그인은 설치할 때 빌드하지 않는다).

통합 시험은 자기가 연 탭에만 표시를 달아 열고 닫으며 사용자 탭은 건드리지 않는다. `spikes/` 에는 `.mcpb` 안에서 osascript 가 도는지 · 사파리 창 최소 폭을 재 보는 첫 시험이 들어 있다.
