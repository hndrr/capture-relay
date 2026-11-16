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
  let guideCleanup: (() => void) | null = null;

  function setRecordGuide(rect: BoxRect | null, selector?: string): void {
    guideCleanup?.();
    guideCleanup = null;
    guideBox?.remove();
    guideBox = null;
    if (!rect) return;
    let current: BoxRect = { ...rect };
    const box = document.createElement('div');
    const applyPos = (): void => {
      box.style.left = `${current.x - 2}px`;
      box.style.top = `${current.y - 2}px`;
      box.style.width = `${current.width + 4}px`;
      box.style.height = `${current.height + 4}px`;
    };
    box.style.cssText = [
      'position:fixed',
      'box-sizing:border-box',
      'border:2px dashed #ff6b6b',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.45)',
      'border-radius:3px',
      'pointer-events:none',
      'z-index:2147483645',
    ].join(';');
    applyPos();

    let trackingActive = Boolean(selector);
    let notifyTimer: number | null = null;
    const notifyMoved = (): void => {
      if (notifyTimer !== null) window.clearTimeout(notifyTimer);
      notifyTimer = window.setTimeout(() => {
        notifyTimer = null;
        void chrome.runtime.sendMessage({
          type: 'RECORD_GUIDE_MOVED',
          rect: current,
          viewport: viewSize(),
        }).catch(() => undefined);
      }, 60);
    };

    const syncFromElement = (): void => {
      if (!trackingActive || !selector) return;
      const target = document.querySelector(selector);
      if (!target) return;
      const next = rectOf(target);
      if (next.width < 1 || next.height < 1) return;
      current = next;
      applyPos();
      notifyMoved();
    };

    const resizeObs = selector ? new ResizeObserver(syncFromElement) : null;
    if (selector) {
      const target = document.querySelector(selector);
      if (target) resizeObs?.observe(target);
      window.addEventListener('resize', syncFromElement, { passive: true });
      window.addEventListener('scroll', syncFromElement, { capture: true, passive: true });
    }

    const stopTracking = (): void => {
      if (!trackingActive) return;
      trackingActive = false;
      resizeObs?.disconnect();
      window.removeEventListener('resize', syncFromElement);
      window.removeEventListener('scroll', syncFromElement, true);
    };

    guideCleanup = () => {
      if (notifyTimer !== null) window.clearTimeout(notifyTimer);
      stopTracking();
    };

    const handle = document.createElement('div');
    handle.textContent = '⋮⋮ 移動';
    handle.style.cssText = [
      'position:absolute',
      'left:-2px',
      'top:-22px',
      'padding:2px 7px',
      'font:600 11px/16px sans-serif',
      'color:#fff',
      'background:#e04f4f',
      'border-radius:4px 4px 0 0',
      'cursor:grab',
      'user-select:none',
      'pointer-events:auto',
    ].join(';');

    handle.addEventListener('mousedown', (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      stopTracking();
      const startX = event.clientX;
      const startY = event.clientY;
      const origX = current.x;
      const origY = current.y;
      handle.style.cursor = 'grabbing';

      const onMove = (e: MouseEvent): void => {
        const maxX = Math.max(0, document.documentElement.clientWidth - current.width);
        const maxY = Math.max(0, document.documentElement.clientHeight - current.height);
        current = {
          ...current,
          x: Math.max(0, Math.min(maxX, origX + (e.clientX - startX))),
          y: Math.max(0, Math.min(maxY, origY + (e.clientY - startY))),
        };
        applyPos();
      };

      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        handle.style.cursor = 'grab';
        void chrome.runtime.sendMessage({
          type: 'RECORD_GUIDE_MOVED',
          rect: current,
          viewport: viewSize(),
        }).catch(() => undefined);
      };

      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });

    const addResizeHandle = (mode: 'e' | 's' | 'se', css: string): void => {
      const grip = document.createElement('div');
      grip.style.cssText = `position:absolute;pointer-events:auto;user-select:none;${css}`;
      grip.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        stopTracking();
        const startX = event.clientX;
        const startY = event.clientY;
        const origW = current.width;
        const origH = current.height;
        const maxW = Math.max(16, document.documentElement.clientWidth - current.x);
        const maxH = Math.max(16, document.documentElement.clientHeight - current.y);

        const onMove = (e: MouseEvent): void => {
          current = {
            ...current,
            width: mode === 's' ? origW : Math.max(16, Math.min(maxW, origW + (e.clientX - startX))),
            height: mode === 'e' ? origH : Math.max(16, Math.min(maxH, origH + (e.clientY - startY))),
          };
          applyPos();
        };

        const onUp = (): void => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
          void chrome.runtime.sendMessage({
            type: 'RECORD_GUIDE_MOVED',
            rect: current,
            viewport: viewSize(),
          }).catch(() => undefined);
        };

        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });
      box.append(grip);
    };

    addResizeHandle('e', 'top:0;right:-5px;width:10px;height:100%;cursor:ew-resize;');
    addResizeHandle('s', 'left:0;bottom:-5px;width:100%;height:10px;cursor:ns-resize;');
    addResizeHandle('se', 'right:-6px;bottom:-6px;width:12px;height:12px;background:#e04f4f;border:1px solid #fff;border-radius:2px;cursor:nwse-resize;');

    box.append(handle);
    document.documentElement.append(box);
    guideBox = box;
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'CONFIGURE_RULE' && message.type !== 'PICK' && message.type !== 'SET_RECORD_GUIDE') return;
    if (message.type === 'SET_RECORD_GUIDE') {
      setRecordGuide(message.rect, message.selector);
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
