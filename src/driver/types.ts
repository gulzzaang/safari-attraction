export interface WindowInfo {
  id: number;
  index: number;
  isPrivate: boolean;
  tabCount: number;
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
  | "SAFARI_ERROR";

export class SafariError extends Error {
  code: SafariErrorCode;
  constructor(code: SafariErrorCode, message: string) {
    super(message);
    this.name = "SafariError";
    this.code = code;
  }
}

export interface SafariDriver {
  listWindows(): Promise<WindowInfo[]>;
  listTabs(): Promise<TabInfo[]>;
  /** 활성 탭을 바꾸지 않고, 사파리를 앞으로 가져오지 않고 뒤쪽 탭을 연다. 페이지가 뜰 때까지 기다린다. */
  openTab(url: string, opts?: { windowId?: number }): Promise<{ tab: TabInfo; frontAppChanged: boolean }>;
  runJs(tabKey: string, source: string, opts?: { timeoutMs?: number }): Promise<string>;
  closeTab(tabKey: string): Promise<void>;
  /**
   * 우리가 제자리에서 이동시킨 탭(주소 이동 · 링크 클릭 · 폼 전송)에 같은 키를 다시 붙인다.
   * 새 문서가 뜨면 탭 표시가 사라지므로, 이동을 시킨 쪽이 바로 부른다. 불러오기가 끝나길 기다린 뒤 탭 정보를 돌려준다.
   * 기록한 자리의 탭에 다른 키의 표시가 있으면 TAB_CLOSED.
   */
  rebindTab(tabKey: string): Promise<TabInfo>;
  /**
   * 동작 뒤 탭이 제자리에서 이동했는지 본다 — rebindTab 의 읽기 전용 짝. 이동하지 않았으면(탭에 이 키의 표시가 그대로)
   * navigated:false(leaving: 문서를 떠나는 중이니 더 기다려야 할 수 있다). 새 문서가 떴으면(표시가 없음) 다 뜰 때까지 기다려
   * 표시를 다시 적고 navigated:true. 표시가 없다는 이유로 키를 지우지 않는다 — 다른 키의 표시가 있거나 탭이 정말 없을 때만
   * TAB_CLOSED(그때만 키를 지운다).
   */
  settleTab(tabKey: string): Promise<{ navigated: boolean; leaving: boolean; tab: TabInfo }>;
  /** 이 드라이버가 연 탭을 모두 닫는다(사용자 탭은 그대로). 닫은 수를 돌려준다. */
  closeOwned(): Promise<number>;
  close(): Promise<void>;
}
