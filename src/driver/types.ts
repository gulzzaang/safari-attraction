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
  /** 이 드라이버가 연 탭을 모두 닫는다(사용자 탭은 그대로). 닫은 수를 돌려준다. */
  closeOwned(): Promise<number>;
  close(): Promise<void>;
}
