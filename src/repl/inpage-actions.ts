/**
 * 페이지 안에서 도는 동작 코드(click · fill · 글쇠 · evaluate · goto). 진짜 입력이 아니라 이벤트를 보내는 방식이다 —
 * 사파리를 앞으로 가져오지 않고 뒤쪽 탭에서도 돌려야 해서다(화면 좌표 클릭은 쓰지 않는다).
 *
 * 한 번 부르면 즉시 실행 함수 하나가 돌고, 값은 JSON 글이다.
 *   성공  {"ok":true,"r":{…}}   r.expectNav = 이 동작이 이 문서를 떠나는 이동을 일으켰다고 그 자리에서 알 수 있다
 *   실패  {"ok":false,"err":"한국어 문장"}
 * 사파리의 `do JavaScript` 는 마지막 식의 값을 돌려주고 약속(Promise)은 기다려 주지 않는다.
 * 페이지 안에서 문자열을 eval 하는 곳은 없다(엄격한 CSP 에서도 돌도록).
 */

export type ActionOp = "click" | "fill" | "text" | "press" | "type" | "goto";

/** 페이지 안에서 동작이 끝난 뒤 보내는 결과. */
export interface ActionOk {
  ok: true;
  r: {
    /** 링크 · 폼 제출 · goto 처럼 문서를 떠나는 이동이 일어난 게 분명하다. */
    expectNav?: boolean;
    text?: string;
    /** 동작 중 페이지가 setTimeout 으로 잡아 둔 가장 긴 지연(ms). 없으면 -1. 늦게 일어나는 이동(타이머 리다이렉트)을 기다릴지 정한다. */
    timerMs?: number;
    /** evaluate 결과를 JSON.stringify 한 글(undefined 면 없다). */
    s?: string;
    /** 결과가 약속이라 끝나길 기다려야 한다 — window.__saPend[pending] 을 읽는다. */
    pending?: string;
  };
}
export interface ActionErr {
  ok: false;
  err: string;
}

/** evaluate 가 약속을 돌려줬을 때 결과를 읽는 글. */
export function buildPendingReadSource(id: string): string {
  return `(function(){var p=window.__saPend&&window.__saPend[${JSON.stringify(id)}];if(!p)return JSON.stringify({state:'lost'});if(p.state!=='pending')delete window.__saPend[${JSON.stringify(id)}];return JSON.stringify(p)})()`;
}

export function buildActionSource(op: ActionOp, args: Record<string, unknown> & { tok: string }): string {
  return `(function(A){${plant('A')}${PRELUDE}${BODY}})(${JSON.stringify({ ...args, op })})`;
}

const plant = (arg: string) => PLANT.split('__SA_ARG__').join(arg);

/**
 * evaluate 는 식 · 함수의 소스를 스크립트 글에 그대로 끼워 넣는다 — 페이지 안에서 문자열을 eval 하지 않으므로
 * 엄격한 CSP(unsafe-eval 없음)에서도 돈다. 다른 동작의 도우미 함수와 이름이 부딪치지 않게 따로 만든 스크립트다.
 * 식이어야 한다(함수 식이면 arg 를 넣어 부른다). 문법 오류는 스크립트 전체를 깨뜨리므로 부르기 전에 걸러야 한다(page.ts).
 */
export function buildEvalSource(src: string, arg: unknown, tok: string): string {
  return `(function(__saA){${plant('__saA')}
  try {
    var __saVal = (function(){ return (${src}
    ); })();
    if (typeof __saVal === 'function') __saVal = __saVal(__saA.arg);
    var __saR = { timerMs: __saTimers() };
    if (__saVal && typeof __saVal.then === 'function') {
      window.__saPend = window.__saPend || {};
      var __saRec = window.__saPend[__saA.tok] = { state: 'pending' };
      __saVal.then(function (v) { try { __saRec.s = JSON.stringify(v); __saRec.state = 'ok'; } catch (e) { __saRec.err = '결과를 JSON 으로 바꿀 수 없음: ' + (e && e.message); __saRec.state = 'err'; } },
                   function (e) { __saRec.err = String((e && e.message) || e); __saRec.state = 'err'; });
      __saR.pending = __saA.tok;
    } else {
      try { __saR.s = JSON.stringify(__saVal); } catch (e) { return JSON.stringify({ ok: false, err: '결과를 JSON 으로 바꿀 수 없음: ' + (e && e.message) }); }
    }
    return JSON.stringify({ ok: true, r: __saR });
  } catch (e) {
    return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
  } finally { __saTimersStop(); }
})(${JSON.stringify({ arg, tok })})`;
}

// 페이지 안에서 도는 코드. 문자열로 둔다(번들러가 함수 이름을 끼워 넣어도 깨지지 않게).
// 백틱 · ${ 는 쓰지 않는다(String.raw).
// 모든 동작의 첫머리: 표시를 심고, 문서를 떠나는 중인지(beforeunload) 깃발을 세우고, 동작 동안 setTimeout 지연을 적어 둔다.
// __SA_ARG__ 는 인자 변수 이름으로 바꿔 넣는다(일반 동작 A, evaluate __saA — 페이지 전역 이름과 안 부딪치게).
const PLANT = String.raw`
  window.__saTok = __SA_ARG__.tok;
  window.__saLeaving = false;
  if (!window.__saUnl) {
    window.__saUnl = 1;
    window.addEventListener('beforeunload', function () { window.__saLeaving = true; });
  }
  var __saOrigST = window.setTimeout, __saMax = -1;
  function __saPatched(fn, ms) { var d = +ms || 0; if (d > __saMax) __saMax = d; return __saOrigST.apply(this, arguments); }
  window.setTimeout = __saPatched;
  function __saTimers() { return __saMax; }
  function __saTimersStop() { if (window.setTimeout === __saPatched) window.setTimeout = __saOrigST; }
`;

const PRELUDE = String.raw`
  function fail(msg) { var e = new Error(msg); e.saPlain = true; throw e; }
  function find(ref) {
    var isRef = /^e\d+$/.test(ref);
    var el;
    try { el = document.querySelector(isRef ? '[data-sa-ref="' + ref + '"]' : ref); }
    catch (e) { fail('선택자가 잘못됨: ' + ref); }
    if (!el) {
      fail(isRef
        ? ref + ' 요소를 찾을 수 없음 — 페이지가 바뀌었을 수 있으니 snapshot 을 다시 찍어 새 ref 를 쓰세요'
        : '선택자에 맞는 요소 없음: ' + ref + ' — snapshot 으로 지금 화면을 확인하세요');
    }
    return el;
  }
  function linkNav(a) {
    var h = a.getAttribute('href');
    if (!h || h.charAt(0) === '#' || /^\s*(javascript:|mailto:|tel:)/i.test(h)) return false;
    var t = (a.target || '').toLowerCase();
    if ((t && t !== '_self') || a.hasAttribute('download')) return false;
    try {
      var u = new URL(a.href, location.href);
      if (!/^(https?|file):$/.test(u.protocol)) return false;
      if (u.hash && u.href.split('#')[0] === location.href.split('#')[0]) return false;
    } catch (e) { return false; }
    return true;
  }
  // 동작 동안 submit 이벤트를 지켜본다(막히지 않고 제출됐으면 이동이 일어난다).
  var sub = { fired: false, nav: false };
  function onSubmit(e) {
    sub.fired = true;
    var f = e.target;
    var tg = ((f && f.target) || '').toLowerCase();
    if (!e.defaultPrevented && (!tg || tg === '_self') && !(f && f.method && f.method.toLowerCase() === 'dialog')) sub.nav = true;
  }
  window.addEventListener('submit', onSubmit);

  function mouse(type, el, x, y, buttons) {
    var init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
                 screenX: x, screenY: y, button: 0, buttons: buttons, detail: type === 'click' ? 1 : 0 };
    var ev;
    if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
      init.pointerType = 'mouse'; init.isPrimary = true; init.pointerId = 1;
      ev = new PointerEvent(type, init);
    } else ev = new MouseEvent(type, init);
    return el.dispatchEvent(ev);
  }
  var FOCUSABLE = 'input,textarea,select,button,a[href],summary,[tabindex],[contenteditable=""],[contenteditable=true]';
  function doClick(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') fail('비활성 요소라 누를 수 없음');
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    mouse('pointerdown', el, x, y, 1);
    mouse('mousedown', el, x, y, 1);
    var f = el.closest ? el.closest(FOCUSABLE) : null;
    if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    mouse('pointerup', el, x, y, 0);
    mouse('mouseup', el, x, y, 0);
    var notPrevented = mouse('click', el, x, y, 0);
    var a = el.closest ? el.closest('a[href]') : null;
    return notPrevented && ((a && linkNav(a)) || sub.nav);
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return /^(text|search|email|url|tel|password|number|)$/i.test(el.getAttribute('type') || '');
  }
  function setNativeValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }
  function inputEvent(el, type, data) {
    var ev;
    try { ev = new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true, inputType: data === null ? 'deleteContentBackward' : 'insertText', data: data }); }
    catch (e) { ev = new Event(type, { bubbles: true }); }
    return el.dispatchEvent(ev);
  }
  // 글자 하나(또는 지우기: ch === null)를 입력칸의 커서 자리에 넣는다.
  function insert(el, ch) {
    if (isTextField(el)) {
      var v = el.value;
      var s = v.length, e = v.length;
      try { if (el.selectionStart !== null) { s = el.selectionStart; e = el.selectionEnd; } } catch (x) {}
      if (ch === null) { if (s === e) { if (s === 0) return; s = s - 1; } ch = ''; }
      if (!inputEvent(el, 'beforeinput', ch === '' ? null : ch)) return;
      setNativeValue(el, v.slice(0, s) + ch + v.slice(e));
      try { el.setSelectionRange(s + ch.length, s + ch.length); } catch (x) {}
      inputEvent(el, 'input', ch === '' ? null : ch);
    } else if (el && el.isContentEditable) {
      if (ch === null) document.execCommand('delete'); else document.execCommand('insertText', false, ch);
    }
  }

  var KEYS = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
    Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'] };
  var ALIAS = { Esc: 'Escape', Return: 'Enter', ' ': 'Space', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
  function keyEvent(type, name, target) {
    var info = KEYS[name];
    var ch = name === 'Space' ? ' ' : name;
    var kc = info ? info[0] : (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
    var code = info ? info[1] : (/^[a-z]$/i.test(name) ? 'Key' + name.toUpperCase() : (/^[0-9]$/.test(name) ? 'Digit' + name : ''));
    var init = { key: ch, code: code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, view: window };
    if (type === 'keypress') { var cc = ch.length === 1 ? ch.charCodeAt(0) : (name === 'Enter' ? 13 : 0); init.charCode = cc; init.keyCode = cc; init.which = cc; }
    return target.dispatchEvent(new KeyboardEvent(type, init));
  }
  function activeTarget() {
    var t = document.activeElement;
    return (!t || t === document.documentElement) ? document.body : t;
  }
  function nextFocus(from, back) {
    var all = Array.prototype.filter.call(document.querySelectorAll('input,textarea,select,button,a[href],summary,[tabindex],[contenteditable=""],[contenteditable=true]'), function (e) {
      return !e.disabled && e.getAttribute('tabindex') !== '-1' && e.type !== 'hidden' && (e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    });
    if (!all.length) return null;
    var i = all.indexOf(from);
    return all[i < 0 ? (back ? all.length - 1 : 0) : (i + (back ? -1 : 1) + all.length) % all.length];
  }

  // 글쇠 하나를 누른다. 이동이 일어났으면 true.
  function pressKey(name) {
    name = ALIAS[name] || name;
    var t = activeTarget();
    var mo = new MutationObserver(function () {});
    mo.observe(document, { childList: true, attributes: true, characterData: true, subtree: true });
    var href0 = location.href;
    var nav = false;
    try {
      var go = keyEvent('keydown', name, t);
      var proceed = go;
      if (go && (name.length === 1 || name === 'Enter' || name === 'Space')) proceed = keyEvent('keypress', name, t);
      if (proceed) {
        if (name.length === 1) insert(t, name);
        else if (name === 'Space') insert(t, ' ');
        else if (name === 'Backspace') insert(t, null);
        else if (name === 'Tab') { var n = nextFocus(t, false); if (n) n.focus(); }
        else if (name === 'Enter') {
          if (t.tagName === 'TEXTAREA') insert(t, '\n');
          else if (t.isContentEditable) document.execCommand('insertParagraph');
          else if (t.tagName === 'A' || t.tagName === 'BUTTON' || t.tagName === 'SUMMARY' || (t.tagName === 'INPUT' && /^(submit|button|image|reset|checkbox|radio)$/i.test(t.type))) nav = doClick(t);
        }
      }
      keyEvent('keyup', name, t);
      if (name === 'Enter' && t.tagName === 'INPUT' && t.form && !nav) {
        // 입력칸에서 엔터를 쳤는데 막혔거나 아무 일도 없으면(합성 키 이벤트는 폼을 알아서 제출하지 않는다) 폼을 제출한다.
        var happened = sub.fired || mo.takeRecords().length > 0 || location.href !== href0;
        if (!go || !proceed || !happened) {
          if (!sub.fired) { try { t.form.requestSubmit(); } catch (e) { fail('폼 제출에 실패: ' + (e && e.message)); } }
        }
      }
    } finally { mo.disconnect(); }
    return nav || sub.nav;
  }

`;

const BODY = String.raw`
  try {
    var r = {};
    switch (A.op) {
      case 'click': {
        var el = find(A.ref);
        r.expectNav = !!doClick(el);
        break;
      }
      case 'fill': {
        var el = find(A.ref);
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        if (el.tagName === 'SELECT') {
          el.focus(); el.value = A.value;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|file|button|submit|image|reset|range|color|hidden)$/i.test(el.type))) {
          el.focus();
          setNativeValue(el, A.value);
          inputEvent(el, 'input', A.value);
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.focus();
          document.execCommand('selectAll', false, null);
          if (A.value === '') document.execCommand('delete'); else document.execCommand('insertText', false, A.value);
        } else {
          fail('글을 채울 수 없는 요소임(' + el.tagName.toLowerCase() + ') — 입력칸이나 편집 가능한 영역을 고르세요');
        }
        break;
      }
      case 'text': {
        r.text = find(A.ref).textContent || '';
        break;
      }
      case 'press': {
        r.expectNav = !!pressKey(String(A.key));
        break;
      }
      case 'type': {
        var chars = Array.from(String(A.text)), nav = false;
        for (var i = 0; i < chars.length; i++) { if (chars[i] === '\n') nav = pressKey('Enter') || nav; else pressKey(chars[i]); }
        r.expectNav = nav || sub.nav;
        break;
      }
      case 'goto': {
        var next = new URL(A.url, location.href);
        var hashOnly = next.hash !== '' && next.href.split('#')[0] === location.href.split('#')[0];
        location.href = A.url;
        r.expectNav = !hashOnly;
        break;
      }
      default: fail('알 수 없는 동작: ' + A.op);
    }
    r.timerMs = __saTimers();
    return JSON.stringify({ ok: true, r: r });
  } catch (e) {
    return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
  } finally {
    window.removeEventListener('submit', onSubmit);
    __saTimersStop();
  }
`;
