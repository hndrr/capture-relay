import { clampCaptureRect, exportFilename } from './rect.js';

const LOG_KEY = 'captureRelayEvents';
const ARMED_KEY = 'captureRelayArmed';
const SETTINGS_KEY = 'captureRelaySettings';
let savingLogs: Promise<void> = Promise.resolve();
const lastAutoCapture = new Map<number, number>();

async function readSaveSettings(): Promise<SaveSettings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = data[SETTINGS_KEY] as Partial<SaveSettings> | undefined;
  return {
    saveFolder: typeof raw?.saveFolder === 'string' && raw.saveFolder.trim() ? raw.saveFolder : 'capture-relay',
    saveAs: Boolean(raw?.saveAs),
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});
// Service workers may restart: set the action behavior whenever started as well.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.action.onClicked.addListener(tab => {
  void chrome.sidePanel.open({ windowId: tab.windowId });
});

async function appendLog(record: EventRecord): Promise<void> {
  savingLogs = savingLogs.catch(() => undefined).then(async () => {
    const data = await chrome.storage.local.get(LOG_KEY);
    const prev = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] as EventRecord[] : [];
    await chrome.storage.local.set({ [LOG_KEY]: [...prev.slice(-249), record] });
  });
  await savingLogs;
}

function log(kind: string, detail: string, tabId?: number, selector?: string, timestamp = Date.now()): Promise<void> {
  const record: EventRecord = { id: crypto.randomUUID(), timestamp, kind, detail };
  if (tabId !== undefined) record.tabId = tabId;
  if (selector !== undefined) record.selector = selector;
  return appendLog(record);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function capture(message: Extract<ExtMessage, { type: 'CAPTURE' }>): Promise<string> {
  const tab = await chrome.tabs.get(message.tabId);
  const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (active?.id !== message.tabId) throw new Error('選択したタブがアクティブではありません。');
  const fullData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  let finalData = fullData;
  if (message.rect && message.viewport) {
    const bitmap = await createImageBitmap(await (await fetch(fullData)).blob());
    try {
      const clipped = clampCaptureRect(message.rect, message.viewport, { width: bitmap.width, height: bitmap.height });
      if (!clipped) throw new Error('選択範囲がビューポートの外にあります。');
      const canvas = new OffscreenCanvas(clipped.width, clipped.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('画像処理コンテキストを作成できません。');
      ctx.drawImage(bitmap, clipped.x, clipped.y, clipped.width, clipped.height, 0, 0, clipped.width, clipped.height);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      finalData = `data:image/png;base64,${base64FromBytes(new Uint8Array(await blob.arrayBuffer()))}`;
    } finally {
      bitmap.close();
    }
  }
  const settings = await readSaveSettings();
  const filename = exportFilename(message.prefix ?? 'screenshot', Date.now(), 'png', settings.saveFolder);
  await chrome.downloads.download({ url: finalData, filename, saveAs: settings.saveAs });
  await log('screenshot', filename, message.tabId);
  return filename;
}

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function arm(tabId: number, rule: TriggerRule): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.match(/^https?:\/\//)) throw new Error('DOM監視はhttp(s)ページでのみ利用できます。');
  // Validate before persisting: invalid CSS selectors must never be armed.
  if (!rule.selector.trim() || rule.selector.length > 500) throw new Error('セレクタは1〜500文字にしてください。');
  const existing = (await chrome.storage.local.get(ARMED_KEY))[ARMED_KEY] as ArmedRule | undefined;
  if (existing && existing.tabId !== tabId) await disarm(existing.tabId);
  await inject(tabId);
  const ack = await chrome.tabs.sendMessage(tabId, { type: 'CONFIGURE_RULE', tabId, rule });
  if (!ack.ok) throw new Error(ack.error);
  await chrome.storage.local.set({ [ARMED_KEY]: { tabId, rule } satisfies ArmedRule });
  await log('armed', `${rule.when} → ${rule.action}`, tabId, rule.selector);
}

async function disarm(tabId: number): Promise<void> {
  const data = await chrome.storage.local.get(ARMED_KEY);
  const current = data[ARMED_KEY] as ArmedRule | undefined;
  if (current?.tabId === tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'CONFIGURE_RULE', tabId, rule: null }); } catch { /* tab already closed */ }
    await chrome.storage.local.remove(ARMED_KEY);
    await log('disarmed', '監視を停止しました', tabId);
  }
}

async function onTrigger(message: TriggerFired, tabId: number): Promise<void> {
  const data = await chrome.storage.local.get(ARMED_KEY);
  const armed = data[ARMED_KEY] as ArmedRule | undefined;
  if (!armed || armed.tabId !== tabId || armed.rule.selector !== message.rule.selector || armed.rule.action !== message.rule.action || armed.rule.when !== message.rule.when) return;
  await log('trigger', `${message.rule.when} → ${message.rule.action}`, tabId, message.rule.selector, message.timestamp);
  if (message.rule.action !== 'screenshot') return;
  const previous = lastAutoCapture.get(tabId) ?? 0;
  if (Date.now() - previous < 900) return; // captureVisibleTab is limited to two calls per second.
  lastAutoCapture.set(tabId, Date.now());
  try {
    const rect = message.rule.crop ? message.rect : undefined;
    await capture({ type: 'CAPTURE', tabId, ...(rect ? { rect, viewport: message.viewport } : {}), prefix: 'trigger' });
  } catch (e) {
    await log('error', `トリガー撮影: ${String(e)}`, tabId, message.rule.selector);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'CONFIGURE_RULE' || message.type === 'PICK' || message.type === 'SET_RECORD_GUIDE') return;
  const work = async (): Promise<ExtResponse> => {
    try {
      switch (message.type) {
        case 'ARM_TRIGGER': await arm(message.tabId, message.rule); return { ok: true, data: null };
        case 'DISARM_TRIGGER': await disarm(message.tabId); return { ok: true, data: null };
        case 'CAPTURE': return { ok: true, data: await capture(message) };
        case 'ADD_LOG': await appendLog(message.record); return { ok: true, data: null };
        case 'TRIGGER_FIRED':
          if (sender.tab?.id === undefined || sender.tab.id !== message.tabId) return { ok: false, error: 'Invalid trigger sender' };
          await onTrigger(message, sender.tab.id);
          return { ok: true, data: null };
      }
      return { ok: false, error: 'Unknown message' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  void work().then(respond);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status !== 'complete' || !tab.url?.startsWith('http')) return;
  void (async () => {
    const data = await chrome.storage.local.get(ARMED_KEY);
    const armed = data[ARMED_KEY] as ArmedRule | undefined;
    if (armed?.tabId !== tabId) return;
    try {
      await inject(tabId);
      const ack = await chrome.tabs.sendMessage(tabId, { type: 'CONFIGURE_RULE', tabId, rule: armed.rule });
      if (!ack.ok) throw new Error(ack.error);
    } catch (e) { await log('error', `再監視: ${String(e)}`, tabId); }
  })();
});

chrome.tabs.onRemoved.addListener(tabId => {
  void disarm(tabId).catch(() => undefined);
});
