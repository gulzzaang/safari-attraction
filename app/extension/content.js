// 사파리-어트랙션 확장 content script — 페이지 위에 작은 패널(닫힌 Shadow DOM)을 그린다.
// - 토큰 · 포트를 모른다: 묻기는 background 로 port 메시지를 보내고, 답(delta · done · error · info)만 받는다.
// - 답은 textContent 로만 넣는다(HTML 로 해석하지 않음). 링크는 http · https 만 새 탭(noopener)으로.
(function () {
  "use strict";
  const ext = globalThis.browser || globalThis.chrome;
  const lib = globalThis.SAPanelLib;
  if (!ext || !lib || globalThis.__saPanelLoaded) return;
  globalThis.__saPanelLoaded = true;

  const PREF_KEY = "includePage";

  let host = null;        // 페이지에 붙는 바깥 요소
  let ui = null;          // 패널 안 요소 모음
  let port = null;        // background 와의 연결
  let cssText = null;
  let openedSelection = "";
  let previousFocus = null;
  let answering = false;
  let askCounter = 0;      // 묻기 번호(질문마다 +1)
  let currentAskId = null; // 지금 답을 기다리는 묻기 번호(없으면 null)
  let answerText = "";
  let renderQueued = false;
  let includePagePref = true;

  // ── 작은 도우미 ────────────────────────────────────────────────────────────
  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /** 키 입력이 페이지로 새지 않게 막는다(페이지의 단축키 · 입력 가로채기). */
  function isolateKeys(el) {
    for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input"]) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  async function loadCss() {
    if (cssText !== null) return cssText;
    try {
      const reply = await ext.runtime.sendMessage({ t: "css" });
      cssText = reply && typeof reply.css === "string" ? reply.css : "";
    } catch (_) {
      cssText = "";
    }
    return cssText;
  }

  async function loadPref() {
    try {
      const got = await ext.storage.local.get(PREF_KEY);
      if (got && typeof got[PREF_KEY] === "boolean") includePagePref = got[PREF_KEY];
    } catch (_) { /* 저장소를 못 읽어도 기본(켬) */ }
  }

  function savePref(value) {
    includePagePref = value;
    try { ext.storage.local.set({ [PREF_KEY]: value }); } catch (_) { /* 무시 */ }
  }

  // ── 패널 그리기 ────────────────────────────────────────────────────────────
  async function build() {
    host = document.createElement("div");
    // 페이지 CSS 가 섞이지 않게 CSSOM 으로 직접(속성 파싱을 안 거쳐 CSP 에도 안 걸린다).
    const hostStyle = {
      all: "initial", position: "fixed", right: "16px", bottom: "16px", "z-index": "2147483647",
      width: "min(400px, calc(100vw - 32px))", display: "block",
    };
    for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });

    const css = await loadCss();
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = document.createElement("style");
      style.textContent = css;
      root.appendChild(style);
    }

    const panel = h("section", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "사파리-어트랙션 패널");

    const head = h("header", "head");
    const title = h("span", "title", "사파리-어트랙션");
    const meta = h("span", "meta", "");
    const close = h("button", "icon", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "닫기");
    close.addEventListener("click", () => closePanel());
    head.append(title, meta, close);

    const answer = h("div", "answer");
    answer.setAttribute("aria-live", "polite");
    answer.tabIndex = -1;

    const status = h("div", "status", "");

    const input = h("textarea", "input");
    input.rows = 3;
    input.placeholder = "이 페이지에 대해 물어보세요 (Enter 보내기 · Shift+Enter 줄바꿈 · Esc 닫기)";
    input.setAttribute("aria-label", "질문");
    isolateKeys(input);

    const opts = h("div", "opts");
    const pageLabel = h("label", "opt");
    const pageBox = h("input");
    pageBox.type = "checkbox";
    pageBox.checked = includePagePref;
    const pageText = h("span", "", "이 페이지 함께");
    const selNote = h("span", "note", "");
    pageLabel.append(pageBox, pageText, selNote);
    const webLabel = h("label", "opt");
    const webBox = h("input");
    webBox.type = "checkbox";
    webBox.checked = false;
    webLabel.append(webBox, h("span", "", "웹 검색"));
    const send = h("button", "send", "보내기");
    send.type = "button";
    opts.append(pageLabel, webLabel, send);

    const warn = h("div", "warn", "");

    panel.append(head, answer, status, input, opts, warn);
    root.appendChild(panel);

    ui = { root, panel, meta, answer, status, input, pageBox, webBox, send, selNote, warn };

    // 이벤트 — 패널 안의 키 · Esc
    isolateKeys(panel);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePanel(); }
    });
    input.addEventListener("keydown", (e) => {
      // 입력 칸의 키는 위로(panel) 올라가지 않게 막아 두었으니 Esc 도 여기서 처리한다.
      if (e.key === "Escape") { if (!e.isComposing) { e.preventDefault(); closePanel(); } return; }
      // 한글 조합 중의 Enter 는 글자를 확정하는 것이지 보내기가 아니다.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener("click", () => (answering ? cancel() : submit()));
    pageBox.addEventListener("change", () => { savePref(pageBox.checked); updateWarn(); });
    webBox.addEventListener("change", updateWarn);
    // 마우스 · 포인터 · 휠도 페이지로 새지 않게(바깥 클릭에 닫히는 페이지 팝업 등)
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "touchstart", "pointerdown"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

    document.documentElement.appendChild(host);
    updateSelNote();
    updateWarn();
  }

  function updateSelNote() {
    if (!ui) return;
    const n = Array.from(openedSelection).length;
    ui.selNote.textContent = n > 0 ? "(고른 글 " + n + "자 포함)" : "";
  }

  function updateWarn() {
    if (!ui) return;
    ui.warn.textContent = ui.pageBox.checked && ui.webBox.checked
      ? "페이지 글이 검색을 움직일 수 있어요 — 믿을 수 없는 페이지에서는 둘을 함께 켜지 마세요."
      : "";
  }

  function setStatus(text, isError) {
    if (!ui) return;
    ui.status.textContent = text || "";
    ui.status.classList.toggle("error", !!isError);
  }

  function setAnswering(value) {
    answering = value;
    if (!ui) return;
    ui.send.textContent = value ? "멈춤" : "보내기";
    ui.input.disabled = false;
  }

  // 답 다시 그리기 — 글 조각은 textContent, 링크만 <a>(새 탭 · noopener).
  function renderAnswer() {
    renderQueued = false;
    if (!ui) return;
    const box = ui.answer;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const body = box.querySelector(".a");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    for (const seg of lib.splitLinks(answerText)) {
      if (seg.href) {
        const a = document.createElement("a");
        a.href = seg.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = seg.href;
        a.textContent = seg.text;
        body.appendChild(a);
      } else {
        body.appendChild(document.createTextNode(seg.text));
      }
    }
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderAnswer);
  }

  // ── background 연결 ────────────────────────────────────────────────────────
  function connect() {
    port = ext.runtime.connect({ name: "sa-panel" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      currentAskId = null;
      if (answering) { setAnswering(false); setStatus(lib.errorText("disconnected"), true); }
    });
    port.postMessage({ t: "info" });
  }

  function onPortMessage(msg) {
    if (!ui || !msg) return;
    if (!lib.acceptForAsk(msg, currentAskId)) return; // 멈춘 뒤 · 새 질문 뒤에 늦게 온 옛 줄
    switch (msg.t) {
      case "info": {
        const parts = [msg.cliName, msg.model].filter((s) => typeof s === "string" && s);
        ui.meta.textContent = parts.join(" · ");
        if (msg.loggedIn === false) setStatus("이 CLI 는 로그인이 안 되어 있어요 — 앱 설정에서 로그인해 주세요.", true);
        break;
      }
      case "info-error":
        ui.meta.textContent = "";
        setStatus(typeof msg.message === "string" ? msg.message : lib.errorText("app_off"), true);
        break;
      case "delta":
        if (typeof msg.text === "string") { answerText += msg.text; queueRender(); }
        break;
      case "done":
        currentAskId = null;
        setAnswering(false);
        setStatus("");
        renderAnswer();
        break;
      case "error":
        currentAskId = null;
        setAnswering(false);
        setStatus(typeof msg.message === "string" ? msg.message : lib.errorText("disconnected"), true);
        renderAnswer();
        break;
    }
  }

  function submit() {
    if (!ui || answering) return;
    const question = ui.input.value.trim();
    if (!question) return;
    if (!port) { try { connect(); } catch (_) { setStatus(lib.errorText("native_unavailable"), true); return; } }
    const page = ui.pageBox.checked ? lib.collectPage(document, window, openedSelection) : undefined;
    ui.answer.textContent = "";
    ui.answer.appendChild(h("div", "q", question));
    ui.answer.appendChild(h("div", "a", ""));
    answerText = "";
    const id = ++askCounter;
    currentAskId = id;
    ui.input.value = "";
    setStatus("답을 기다리는 중…");
    setAnswering(true);
    try {
      port.postMessage({ t: "ask", id, question, page, webSearch: ui.webBox.checked });
    } catch (_) {
      setAnswering(false);
      setStatus(lib.errorText("disconnected"), true);
    }
  }

  function cancel() {
    currentAskId = null;
    if (port) { try { port.postMessage({ t: "cancel" }); } catch (_) { /* 무시 */ } }
    setAnswering(false);
    setStatus("멈췄어요.");
  }

  // ── 열기 · 닫기 ────────────────────────────────────────────────────────────
  let opening = false;
  async function openPanel() {
    if (host || opening) return;
    opening = true;
    try {
      // 패널로 초점이 옮겨 가면 고른 글이 풀릴 수 있어서 먼저 적어 둔다(비밀번호 칸이면 빈 글).
      openedSelection = lib.readSelection(document, window);
      previousFocus = document.activeElement;
      await loadPref();
      await build();
      connect();
      ui.input.focus();
    } finally {
      opening = false;
    }
  }

  function closePanel() {
    if (port) { try { port.disconnect(); } catch (_) { /* 무시 */ } port = null; }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; ui = null;
    answering = false; currentAskId = null; answerText = ""; openedSelection = "";
    const back = previousFocus;
    previousFocus = null;
    try { if (back && back.isConnected && typeof back.focus === "function") back.focus(); } catch (_) { /* 무시 */ }
  }

  function toggle() {
    if (host) closePanel(); else if (!opening) openPanel();
  }

  // ── 사이트 알림 알아채기 ────────────────────────────────────────────────────
  // ① 페이지 세계(notify-hook.js)가 감싼 Notification · showNotification 에서 보낸 메시지.
  //    페이지 스크립트도 같은 메시지를 흉내 낼 수 있다 — 그래서 호스트는 메시지가 아니라 location.hostname,
  //    글은 글자만 · 각 1,000자, 탭마다 10초에 한 번까지(앱은 그 사이트를 지켜보는 루틴만 · 10분 쿨다운으로 다시 거른다).
  // ② 탭 제목 앞 (N) · [N] 숫자가 늘어남(처음 값은 기준만).
  const alertLimiter = lib.createRateLimiter(10_000);
  const badgeTracker = lib.createBadgeTracker();

  function sendAlert(kind, title, body) {
    if (!alertLimiter.allow()) return;
    try {
      const sent = ext.runtime.sendMessage({
        t: "alert",
        host: location.hostname,
        kind,
        title: typeof title === "string" ? title.slice(0, lib.ALERT_TEXT_LIMIT * 2) : "",
        body: typeof body === "string" ? body.slice(0, lib.ALERT_TEXT_LIMIT * 2) : "",
      });
      if (sent && typeof sent.catch === "function") sent.catch(() => { /* background 없음 — 버림 */ });
    } catch (_) { /* 확장이 꺼지는 중 — 버림 */ }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const alert = lib.readAlertMessage(e.data);
    if (alert) sendAlert("notification", alert.title, alert.body);
  });

  let lastTitle = null;
  function checkTitle() {
    const title = typeof document.title === "string" ? document.title : "";
    if (title === lastTitle) return;
    lastTitle = title;
    if (badgeTracker.observe(title)) sendAlert("badge", lib.readAlertMessage({ __safariAttractionAlert: 1, title }).title, "");
  }

  // <title> 이 바뀌는 것을 본다. head 가 아직 없으면 documentElement 의 바로 아래만 보다가 head 가 생기면 옮긴다.
  let titleObserver = null;
  function watchTitle() {
    try {
      const head = document.head;
      if (head) {
        titleObserver = new MutationObserver(checkTitle);
        titleObserver.observe(head, { childList: true, subtree: true, characterData: true });
      } else if (document.documentElement) {
        const waiter = new MutationObserver(() => {
          if (document.head) { waiter.disconnect(); watchTitle(); checkTitle(); }
        });
        waiter.observe(document.documentElement, { childList: true });
      }
    } catch (_) { /* MutationObserver 를 못 쓰면 제목 숫자만 못 본다 */ }
    checkTitle();
  }
  watchTitle();

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender || sender.id !== ext.runtime.id) return false;
    if (msg && msg.t === "toggle") { toggle(); sendResponse({ ok: true }); }
    return false;
  });
})();
