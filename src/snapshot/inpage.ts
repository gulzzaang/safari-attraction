export interface SnapshotOptions {
  /** 대화형 요소만(글 덩어리는 뺀다). */
  interactive?: boolean;
  /** 이 CSS 선택자(또는 `e12` 같은 ref)에 맞는 첫 요소 안만 읽는다. */
  selector?: string;
  /** 화면에 보이는 범위가 아니라 문서 전체를 읽는다. */
  full?: boolean;
}

/**
 * 페이지 안에서 돌릴 자바스크립트 원문. 값은 글(문자열)이다 — 머리 줄 `- title: "…" [url=…]` 다음에
 * 대화형 요소 `- <역할> "<이름>" [ref=eN]` 과 글 덩어리 `- <종류> "<글>"` 가 문서 순서대로 이어진다.
 * ref 는 요소에 `data-sa-ref` 로 붙어 같은 문서 안에서는 다시 읽어도 같다.
 * 사파리의 `do JavaScript` 는 마지막 식의 값을 돌려주므로 즉시 실행 함수 하나다.
 */
export function buildSnapshotSource(opts: SnapshotOptions = {}): string {
  const o = { interactive: !!opts.interactive, selector: opts.selector ?? "", full: !!opts.full };
  return `(${PAGE_FN})(${JSON.stringify(o)})`;
}

// 페이지 안에서 도는 코드. 일부러 문자열로 둔다(번들러가 함수 이름을 끼워 넣어도 깨지지 않게).
const PAGE_FN = String.raw`function (o) {
  var NAME_MAX = 60, TEXT_MAX = 140, SOFT_CHARS = 20000;
  var INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=""],[contenteditable=true]';
  var BLOCK = 'h1,h2,h3,h4,p,li,td,th';
  var BLOCK_ROLE = { H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', P: 'paragraph', LI: 'listitem', TD: 'cell', TH: 'cell' };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, svg: 1 };

  function clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

  var title = clip(document.title || '', TEXT_MAX);
  var out = ['- title: ' + q(title) + ' [url=' + location.href + ']'];

  var root = document.body || document.documentElement;
  if (o.selector) {
    var sel = /^e\d+$/.test(o.selector) ? '[data-sa-ref="' + o.selector + '"]' : o.selector;
    try { root = document.querySelector(sel); } catch (e) { return out.concat('- error: ' + q('선택자가 잘못됨: ' + o.selector)).join('\n'); }
    if (!root) return out.concat('- error: ' + q('선택자에 맞는 요소 없음: ' + o.selector)).join('\n');
  }

  // ref 번호는 문서 안에서 이어 붙인다. 이미 붙은 것(이전 읽기 · 다른 도구)의 가장 큰 번호 다음부터.
  if (typeof window.__saRefN !== 'number') {
    var max = 0, used = document.querySelectorAll('[data-sa-ref]');
    for (var u = 0; u < used.length; u++) { var m = /^e(\d+)$/.exec(used[u].getAttribute('data-sa-ref') || ''); if (m && +m[1] > max) max = +m[1]; }
    window.__saRefN = max;
  }
  function refOf(el) {
    var r = el.getAttribute('data-sa-ref');
    if (!r) { r = 'e' + (++window.__saRefN); el.setAttribute('data-sa-ref', r); }
    return r;
  }

  var vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (!o.full && (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw)) return false;
    if (typeof el.checkVisibility === 'function') { if (!el.checkVisibility({ visibilityProperty: true })) return false; }
    else { var cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; }
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  function isInteractive(el) { return el.matches(INTERACTIVE); }
  function isBlock(el) { return el.matches(BLOCK); }

  // 요소의 보이는 글. 안쪽의 대화형 요소 · 다른 글 덩어리는 따로 줄이 되므로 여기서는 뺀다.
  function ownText(el) {
    var s = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.nodeValue + ' ';
        else if (c.nodeType === 1) {
          if (SKIP_TAGS[c.tagName] || c.getAttribute('aria-hidden') === 'true' || c.hidden) continue;
          if (isInteractive(c) || isBlock(c)) continue;
          walk(c);
        }
        if (s.length > TEXT_MAX * 3) return;
      }
    })(el);
    return clip(s, TEXT_MAX);
  }
  function fullText(el) { return clip(el.innerText || el.textContent || '', NAME_MAX); }

  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r && /^(button|link|tab|checkbox|menuitem)$/.test(r)) return r;
    var t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'SUMMARY') return 'summary';
    if (t === 'INPUT') {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
      if (ty === 'file') return 'file';
      if (ty === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return r || 'generic';
  }

  function labelOf(el) {
    try { if (el.labels && el.labels.length) return clip(el.labels[0].textContent || '', NAME_MAX); } catch (e) {}
    return '';
  }

  function describe(el) {
    var role = roleOf(el), t = el.tagName;
    var isPw = t === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password';
    var isField = t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
    var val = '';
    if (isField && !isPw && role !== 'checkbox' && role !== 'radio') {
      if (t === 'SELECT') { var so = el.selectedOptions && el.selectedOptions[0]; val = so ? so.textContent : ''; }
      else val = el.value || '';
    }
    var name = clip(el.getAttribute('aria-label') || '', NAME_MAX)
      || clip(el.getAttribute('placeholder') || '', NAME_MAX)
      || (isField ? labelOf(el) : '')
      || (isField ? '' : fullText(el))
      || (role === 'button' && !isPw ? clip(el.getAttribute('value') || '', NAME_MAX) : '')
      || clip(el.getAttribute('title') || el.getAttribute('alt') || '', NAME_MAX);
    if (!name && val && !isPw) { name = clip(val, NAME_MAX); val = ''; } // 이름이 없을 때만 값을 이름 자리에
    var line = '- ' + role + ' ' + q(name) + ' [ref=' + refOf(el) + ']';
    if (val && !(role === 'button')) line += ' [value=' + q(clip(val, 40)) + ']';
    if ((role === 'checkbox' || role === 'radio') && el.checked) line += ' [checked]';
    else if (el.getAttribute('aria-checked') === 'true') line += ' [checked]';
    if (el.disabled) line += ' [disabled]';
    return line;
  }

  var sel2 = o.interactive ? INTERACTIVE : INTERACTIVE + ',' + BLOCK;
  var list = root.querySelectorAll(sel2), chars = 0, i = 0;
  var cands = [];
  if (root.matches && root.matches(sel2)) cands.push(root);
  for (i = 0; i < list.length; i++) cands.push(list[i]);

  for (i = 0; i < cands.length && chars < SOFT_CHARS; i++) {
    var el = cands[i];
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    if (!shown(el)) continue;
    var line;
    if (isInteractive(el)) line = describe(el);
    else {
      var tx = ownText(el);
      if (!tx) continue;
      line = '- ' + BLOCK_ROLE[el.tagName] + ' ' + q(tx);
    }
    out.push(line);
    chars += line.length + 1;
  }
  return out.join('\n');
}`;
