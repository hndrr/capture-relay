/** Installed only on demand. Does not inject code into the page's JS world. */
(() => {
  const root = globalThis as typeof globalThis & { __captureRelayInstalled?: boolean };
  if (root.__captureRelayInstalled) return;
  root.__captureRelayInstalled = true;

  let armed: { tabId: number; rule: TriggerRule } | null = null;
  let observer: MutationObserver | null = null;
  let previousVisible = false;
  let lastFire = 0;
  let clickListener: ((event: MouseEvent) => void) | null = null;

  function viewSize(): ViewSize {
    return { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  }

  function rectOf(element: Element): BoxRect {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  function selectorOf(element: Element): string {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const path: string[] = [];
    let current: Element | null = element;
    for (let i = 0; current && i < 8; i++) {
      if (current.id) { path.unshift(`#${CSS.escape(current.id)}`); break; }
      const tag = current.tagName.toLowerCase();
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) { path.unshift(tag); break; }
      const sameTag = Array.from(parentElement.children).filter(child => child.tagName === current?.tagName);
      const position = sameTag.indexOf(current) + 1;
      path.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${position})` : tag);
      current = parentElement;
    }
    return path.join(' > ');
  }

  function sendTrigger(rect?: BoxRect): void {
    if (!armed) return;
    const now = Date.now();
    if (now - lastFire < 800) return;
    lastFire = now;
    const message: TriggerFired = {
      type: 'TRIGGER_FIRED', tabId: armed.tabId, rule: armed.rule, timestamp: now,
      viewport: viewSize(), ...(rect ? { rect } : {}),
    };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  function disarm(): void {
    observer?.disconnect(); observer = null;
    if (clickListener) document.removeEventListener('click', clickListener, true);
    clickListener = null;
    armed = null;
  }

  function configure(tabId: number, rule: TriggerRule | null): void {
    disarm();
    if (!rule) return;
    // querySelector throws on invalid selectors; keep the previous rule disarmed.
    const initial = document.querySelector(rule.selector);
    armed = { tabId, rule };
    previousVisible = Boolean(initial);
    lastFire = 0;
    if (rule.when === 'click') {
      clickListener = (event: MouseEvent) => {
        const target = event.target;
        if (target instanceof Element) {
          const matched = target.closest(rule.selector);
          if (matched) sendTrigger(rectOf(matched));
        }
      };
      document.addEventListener('click', clickListener, true);
      return;
    }
    observer = new MutationObserver(() => {
      const element = document.querySelector(rule.selector);
      const visible = Boolean(element);
      if (rule.when === 'appear' && visible && !previousVisible && element) sendTrigger(rectOf(element));
      if (rule.when === 'disappear' && !visible && previousVisible) sendTrigger();
      previousVisible = visible;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }

  function pick(mode: 'element' | 'region'): Promise<PickResult> {
    return new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-capture-relay-picker', '');
      overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;border:2px solid #b4a1ff;background:rgba(157,124,255,.16);pointer-events:none;box-shadow:0 0 0 99999px rgba(8,8,14,.08)';
      document.documentElement.append(overlay);
      let start: { x: number; y: number } | null = null;
      let hovered: Element | null = null;
      let settled = false;

      const remove = (keepClick = false) => {
        overlay.remove();
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mousedown', down, true);
        document.removeEventListener('mouseup', up, true);
        if (!keepClick) document.removeEventListener('click', suppressClick, true);
        document.removeEventListener('keydown', key, true);
      };
      const finish = (result: PickResult) => {
        if (settled) return;
        settled = true; remove(true);
        // Clean up after the click following selection has been intercepted.
        setTimeout(() => document.removeEventListener('click', suppressClick, true), 2000);
        // Wait for the highlight to disappear before the background takes a screenshot.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
      };
      const fail = (reason: string) => { if (settled) return; settled = true; remove(); reject(new Error(reason)); };
      const suppressClick = (event: MouseEvent) => {
        event.preventDefault(); event.stopImmediatePropagation();
        if (settled) document.removeEventListener('click', suppressClick, true);
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); fail('選択をキャンセルしました。'); }
      };
      const render = (rect: BoxRect) => {
        overlay.style.left = `${rect.x}px`; overlay.style.top = `${rect.y}px`;
        overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`;
      };
      const move = (event: MouseEvent) => {
        if (mode === 'element') {
          hovered = event.target instanceof Element ? event.target : null;
          if (hovered && hovered !== overlay) render(rectOf(hovered));
        } else if (start) {
          render({ x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) });
        }
      };
      const down = (event: MouseEvent) => {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.button !== 0) return;
        if (mode === 'element') {
          const element = event.target instanceof Element ? event.target : hovered;
          if (!element || element === overlay) return;
          finish({ rect: rectOf(element), viewport: viewSize(), selector: selectorOf(element) });
        } else {
          start = { x: event.clientX, y: event.clientY };
        }
      };
      const up = (event: MouseEvent) => {
        if (mode !== 'region' || !start) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) };
        if (rect.width < 3 || rect.height < 3) return;
        finish({ rect, viewport: viewSize() });
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mousedown', down, true);
      document.addEventListener('mouseup', up, true);
      document.addEventListener('click', suppressClick, true);
      document.addEventListener('keydown', key, true);
    });
  }

  let guideBox: HTMLDivElement | null = null;

  function setRecordGuide(rect: BoxRect | null): void {
    guideBox?.remove();
    guideBox = null;
    if (!rect) return;
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      `left:${rect.x - 2}px`,
      `top:${rect.y - 2}px`,
      `width:${rect.width + 4}px`,
      `height:${rect.height + 4}px`,
      'box-sizing:border-box',
      'border:2px dashed #ff6b6b',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.45)',
      'border-radius:3px',
      'pointer-events:none',
      'z-index:2147483645',
    ].join(';');
    document.documentElement.append(box);
    guideBox = box;
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'CONFIGURE_RULE' && message.type !== 'PICK' && message.type !== 'SET_RECORD_GUIDE') return;
    if (message.type === 'SET_RECORD_GUIDE') {
      setRecordGuide(message.rect);
      respond({ ok: true, data: null });
      return;
    }
    if (message.type === 'CONFIGURE_RULE') {
      try { configure(message.tabId, message.rule); respond({ ok: true, data: null }); }
      catch (e) { respond({ ok: false, error: String(e) }); }
      return;
    }
    void pick(message.mode)
      .then(result => respond({ ok: true, data: result }))
      .catch(error => respond({ ok: false, error: String(error) }));
    return true;
  });
})();
