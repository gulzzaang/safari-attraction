export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  /** 사파리 창 순서(1 이 맨 앞). */
  index: number;
  isPrivate: boolean;
  tabCount: number;
  /** 닫히지 않은 창인가. listWindows 는 닫혔는데 목록에 남은 창을 빼고 돌려주므로 항상 true 다. */
  visible: boolean;
  /** 최소화한 창인가. 최소화한 창은 닫힌 창이 아니라 목록에 남는다(사파리는 visible 을 false 로 돌려주지만 우리는 닫힌 것으로 보지 않는다). */
  minimized: boolean;
  /** 창 바깥 크기와 자리(화면 점 단위). */
  bounds: WindowBounds;
  /** 현재 탭의 이름. 없으면 빈 글. */
  title: string;
  /** 이 드라이버가 openWindow 로 연 창인가. */
  owned: boolean;
}

export interface TabInfo {
  /** 서버가 정한 탭 키(`t1, t2 …`). 사용자가 탭을 옮기거나 다른 탭이 닫혀도 같은 탭을 가리킨다(TabRegistry). */
  key: string;
  windowId: number;
  /** 창 안의 순서, 1부터. */
  index: number;
  title: string;
  url: string;
  isActive: boolean;
  /** 이 드라이버가 openTab 으로 연 탭인가. */
  owned: boolean;
}

export type SafariErrorCode =
  | "TAB_CLOSED"
  | "ALERT_BLOCKED"
  | "JS_FROM_APPLE_EVENTS_OFF"
  | "AUTOMATION_DENIED"
  | "SAFARI_NOT_RUNNING"
  | "TIMEOUT"
  | "SCREEN_CAPTURE_DENIED"
  | "WINDOW_CLOSED"
  | "SAFARI_ERROR";

export class SafariError extends Error {
  code: SafariErrorCode;
  constructor(code: SafariErrorCode, message: string) {
    super(message);
    this.name = "SafariError";
    this.code = code;
  }
}

/** runJsDetailed 의 결과. */
export interface RunJsDetail {
  value: string;
  /** 소스를 돌린 문서 자신의 주소(location.href). 모르면(느린 길 · 옛 호스트) undefined. */
  url?: string;
  /** 일을 시키기 전에 기록해 둔 그 탭의 주소. */
  urlBefore: string;
  /** 돌린 뒤 문서를 떠나는 중(beforeunload 깃발)인가. 빠른 길만 안다 — 모르면 undefined(이동 확인을 줄이지 말 것). */
  leaving?: boolean;
  /** 우리가 연 탭인가(붙인 사용자 탭이 아니다). */
  owned: boolean;
}

export interface SafariDriver {
  listWindows(): Promise<WindowInfo[]>;
  listTabs(): Promise<TabInfo[]>;
  /**
   * 활성 탭을 바꾸지 않고, 사파리를 앞으로 가져오지 않고 뒤쪽 탭을 연다. 페이지를 쓸 수 있을 때까지(domcontentloaded — load 이벤트까지는 아니다) 기다린다.
   * frontAppChanged: 사파리가 맨 앞으로 나왔나(부르기 전엔 사파리가 아니었고 뒤엔 사파리일 때만 true — 다른 앱이 앞으로 나온 것은 false).
   */
  openTab(url: string, opts?: { windowId?: number; loadBudgetMs?: number }): Promise<{ tab: TabInfo; frontAppChanged: boolean }>;
  /**
   * 그 탭의 페이지 안에서 소스를 돌려 값을 글로 돌려준다. 소스는 **식 하나**(`(소스)` 로 끼워 돌린다 — 문장 · 선언은 즉시 실행 함수로 감싼다. 아니면 SAFARI_ERROR).
   * 탭 확인(표시 읽기 · 필요하면 적기)과 소스 실행이 사파리 호출(doJavaScript) 한 번이다. 값은 글은 그대로, 숫자 · 불리언은 String, null · undefined 는 빈 글, 그 밖은 JSON.stringify.
   * 소스가 던진 오류는 사파리가 오류로 올리지 않아 빈 글이 된다(소스 쪽에서 try/catch 로 JSON 을 돌려주는 게 좋다).
   */
  runJs(tabKey: string, source: string, opts?: { timeoutMs?: number }): Promise<string>;
  /** runJs 와 같되 값 말고 주소 · 떠나는 중 깃발도 돌려준다(동작 뒤 이동 확인을 줄이는 데 쓴다). 없는 드라이버(가짜)는 줄이지 않고 늘 확인한다. */
  runJsDetailed?(tabKey: string, source: string, opts?: { timeoutMs?: number }): Promise<RunJsDetail>;
  /** 그 탭의 마지막으로 알려진 주소(동기). openTab · runJs · settleTab · rebindTab 이 새로 한다. 모르는 키(닫힘)면 undefined. */
  lastUrl(tabKey: string): string | undefined;
  closeTab(tabKey: string): Promise<void>;
  /**
   * 우리가 제자리에서 이동시킨 탭(주소 이동 · 링크 클릭 · 폼 전송)에 같은 키를 다시 붙인다.
   * 새 문서가 뜨면 탭 표시가 사라지므로, 이동을 시킨 쪽이 바로 부른다. 불러오기가 끝나길 기다린 뒤 탭 정보를 돌려준다.
   * 기록한 자리의 탭에 다른 키의 표시가 있으면 TAB_CLOSED.
   */
  rebindTab(tabKey: string): Promise<TabInfo>;
  /**
   * 동작 뒤 탭이 제자리에서 이동했는지 본다 — rebindTab 의 읽기 전용 짝. 이동하지 않았으면(탭에 이 키의 표시가 그대로)
   * navigated:false(leaving: 문서를 떠나는 중이니 더 기다려야 할 수 있다). 새 문서가 떴으면(표시가 없음) 쓸 수 있을 때까지 기다려
   * 표시를 다시 적고 navigated:true. 표시가 없다는 이유로 키를 지우지 않는다 — 다른 키의 표시가 있거나 탭이 정말 없을 때만
   * TAB_CLOSED(그때만 키를 지운다). 「쓸 수 있을 때」는 DOMContentLoaded 이벤트가 끝나고 body 가 있을 때(또는 readyState complete — domcontentloaded)이고,
   * opts.waitUntil 이 "commit" 이면 새 문서가 보이는 즉시 끝낸다.
   * opts.loadBudgetMs 는 호스트가 쓸 수 있을 때를 기다리는 최대 시간(기본 15초, 상한 100초). 넘기면 기다림만 끝내고 그대로 돌려준다(시간 초과 오류는 부른 쪽 몫).
   */
  settleTab(tabKey: string, opts?: { waitUntil?: "commit"; loadBudgetMs?: number }): Promise<{ navigated: boolean; leaving: boolean; tab: TabInfo }>;
  /**
   * 이동이 시간 초과로 끝났음을 알린다(새 문서가 아직 안 떴다). 붙인 사용자 탭이면 늦게 새 문서가 떠도 키를 잃지 않게 「표시 안 한 탭」으로 바꿔 둔다.
   * 우리가 연 탭이거나 이미 바뀐 탭이면 아무 일도 하지 않는다. 실패해도 오류를 올리지 않는다.
   */
  noteNavTimeout?(tabKey: string): Promise<void>;
  /**
   * 활성화 없이 새 창을 열고(앞 앱을 바꾸지 않는다), 크기를 맞추고, 사파리 창 순서 맨 뒤로 보내고, 페이지를 쓸 수 있을 때까지(domcontentloaded) 기다린다.
   * frontAppChanged 는 openTab 과 같은 뜻(사파리가 맨 앞으로 나왔나).
   * 창과 그 탭은 우리 것(owned). width · height 는 창 안 페이지 크기(innerWidth · innerHeight)다.
   */
  openWindow(url: string, opts?: { width?: number; height?: number; loadBudgetMs?: number }): Promise<{ windowId: number; tab: TabInfo; frontAppChanged: boolean }>;
  /**
   * 우리가 연 창(또는 adoptWindow 로 고른 AI 창)의 페이지 크기(innerWidth · innerHeight)를 요청과 같게 맞춘다. 창 바깥 크기를 한 번 재고 한 번 고친다.
   * 사파리 최소 폭보다 좁거나 화면보다 크면 실제 값을 그대로 돌려준다(오류 아님). 그 밖의 창이면 SAFARI_ERROR, 닫힌 창이면 WINDOW_CLOSED.
   */
  setWindowSize(windowId: number, width: number, height: number): Promise<{ innerWidth: number; innerHeight: number }>;
  /** 우리가 연 창만 닫는다. 그 밖의 창은 SAFARI_ERROR, 이미 닫힌 창은 WINDOW_CLOSED. */
  closeWindow(windowId: number): Promise<void>;
  /** 창을 PNG 로 찍는다(긴 변 1568px 이하). 화면 기록 권한이 없으면 SCREEN_CAPTURE_DENIED, 닫힌 창이면 WINDOW_CLOSED. */
  captureWindow(windowId: number): Promise<Buffer>;
  /**
   * 우리가 연 창(또는 adoptWindow 로 고른 AI 창) 안의 탭을 그 창의 현재 탭(화면에 보이는 탭)으로 만든다 — 찍기 전에 쓴다. 사파리를 앞으로 가져오지 않고, 그 밖의 창의 탭이면
   * SAFARI_ERROR(사용자 창은 건드리지 않는다). 탭이 없으면 TAB_CLOSED.
   */
  showTab(tabKey: string): Promise<void>;
  /**
   * 사용자가 AI 전용 창으로 고른 이미 열린 창 하나를 쓸 수 있게 한다 — 그 안의 탭을 showTab 으로 앞에 보이고 setWindowSize 로 크기를 바꿀 수 있다.
   * 우리 창(owned)은 아니므로 closeWindow · closeOwned 는 이 창을 닫지 않는다(우리가 그 안에 연 탭만 닫힌다). 없는 창이면 WINDOW_CLOSED.
   */
  adoptWindow(windowId: number): Promise<void>;
  /** 이 앱에 화면 기록 권한이 있는가(CGPreflightScreenCaptureAccess). */
  screenCaptureAllowed(): Promise<boolean>;
  /** 이 드라이버가 연 창과 탭을 모두 닫는다(사용자 창 · 탭은 그대로). 닫은 수(우리 창 안의 탭은 따로 세지 않는다)를 돌려준다. */
  closeOwned(): Promise<number>;
  close(): Promise<void>;
}
