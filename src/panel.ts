import { clampCaptureRect, exportFilename, sanitizeSaveFolder } from './rect.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
};

const controls = {
  target: $<HTMLSelectElement>('target-tab'),
  selector: $<HTMLInputElement>('selector'),
  when: $<HTMLSelectElement>('trigger-when'),
  action: $<HTMLSelectElement>('trigger-action'),
  crop: $<HTMLInputElement>('crop-trigger'),
  source: $<HTMLSelectElement>('capture-source'),
  pickRecRegion: $<HTMLButtonElement>('pick-rec-region'),
  pickRecElement: $<HTMLButtonElement>('pick-rec-element'),
  clearRecArea: $<HTMLButtonElement>('clear-rec-area'),
  recAreaInfo: $<HTMLDivElement>('rec-area-info'),
  notice: $<HTMLDivElement>('notice'),
  recordInfo: $<HTMLDivElement>('record-info'),
  recordBadge: $<HTMLSpanElement>('rec-badge'),
  micInfo: $<HTMLDivElement>('mic-info'),
  micBadge: $<HTMLSpanElement>('mic-badge'),
  armedBadge: $<HTMLSpanElement>('armed-badge'),
  events: $<HTMLDivElement>('events'),
  prepare: $<HTMLButtonElement>('prepare'),
  release: $<HTMLButtonElement>('release'),
  start: $<HTMLButtonElement>('record-start'),
  stop: $<HTMLButtonElement>('record-stop'),
  micStart: $<HTMLButtonElement>('mic-start'),
  micStop: $<HTMLButtonElement>('mic-stop'),
  arm: $<HTMLButtonElement>('arm-trigger'),
  disarm: $<HTMLButtonElement>('disarm-trigger'),
  saveFolder: $<HTMLInputElement>('save-folder'),
  saveAs: $<HTMLInputElement>('save-as'),
  grantMic: $<HTMLButtonElement>('grant-mic'),
};

const EVENTS_KEY = 'captureRelayEvents';
const ARMED_KEY = 'captureRelayArmed';
const SETTINGS_KEY = 'captureRelaySettings';

type CaptureSource = 'current-tab' | 'tab' | 'display' | 'mic';
type StreamSession = {
  source: CaptureSource;
  stream: MediaStream;
  rawStream?: MediaStream;
  cleanupCrop?: () => void;
  updateCrop?: (rect: BoxRect, viewport: ViewSize) => void;
  monitor?: AudioContext;
  tabId?: number;
  recorder?: MediaRecorder;
  chunks: Blob[];
  startedAt?: number;
};

let session: StreamSession | null = null;
let selectedTabId: number | null = null;
let armedTabId: number | null = null;
let pendingRecPick: PickResult | null = null;
let pendingRecTabId: number | null = null;
let saveSettings: SaveSettings = { saveFolder: 'capture-relay', saveAs: false };
let events: EventRecord[] = [];
let busy = false;
const blobURLs = new Set<string>();

function status(message: string, error = false): void {
  controls.notice.textContent = message;
  controls.notice.title = message;
  controls.notice.parentElement?.classList.toggle('is-error', error);
}

function tabId(): number {
  if (selectedTabId === null) throw new Error('対象タブがありません。');
  return selectedTabId;
}

function humanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateControls();
  try { await task(); }
  catch (error) {
    const msg = humanError(error);
    status(msg, true);
    void addLog('error', msg).catch(() => undefined);
  }
  finally { busy = false; updateControls(); }
}

async function send<T = unknown>(message: ExtMessage): Promise<T> {
  const reply = await chrome.runtime.sendMessage<T>(message);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

function makeLog(kind: string, detail: string, timestamp = Date.now(), tab = selectedTabId ?? undefined, selector?: string): EventRecord {
  const record: EventRecord = { id: crypto.randomUUID(), timestamp, kind, detail };
  if (tab !== undefined) record.tabId = tab;
  if (selector !== undefined) record.selector = selector;
  if (session?.startedAt && session.recorder?.state === 'recording') record.recordingOffsetMs = Math.max(0, timestamp - session.startedAt);
  return record;
}

async function addLog(kind: string, detail: string, timestamp = Date.now(), tab = selectedTabId ?? undefined, selector?: string): Promise<void> {
  await send({ type: 'ADD_LOG', record: makeLog(kind, detail, timestamp, tab, selector) });
}

function renderEvents(): void {
  controls.events.replaceChildren();
  if (!events.length) { const empty = document.createElement('p'); empty.className = 'muted small'; empty.textContent = 'イベントはありません。'; controls.events.append(empty); return; }
  for (const record of events.slice(-50).reverse()) {
    const wrapper = document.createElement('div');
    wrapper.className = record.kind === 'error' ? 'event is-error' : 'event';
    const detail = document.createElement('div'); detail.className = 'detail';
    const title = document.createElement('strong'); title.textContent = `${record.kind} · ${record.detail}`;
    const extra = document.createElement('small');
    extra.textContent = [record.selector, record.tabId === undefined ? '' : `tab ${record.tabId}`, record.recordingOffsetMs === undefined ? '' : `rec +${record.recordingOffsetMs}ms`].filter(Boolean).join(' / ');
    detail.append(title, extra);
    const time = document.createElement('time'); time.textContent = new Date(record.timestamp).toLocaleTimeString('ja-JP', { hour12: false });
    wrapper.append(detail, time); controls.events.append(wrapper);
  }
}

function updateControls(): void {
  const isRecording = session?.recorder?.state === 'recording';
  const isMicSession = session?.source === 'mic';
  const isVideoSession = session !== null && !isMicSession;
  const isVideoRecording = Boolean(isRecording && isVideoSession);
  const isMicRecording = Boolean(isRecording && isMicSession);

  controls.prepare.disabled = busy || session !== null;
  controls.release.disabled = busy || !isVideoSession || isVideoRecording;
  controls.start.disabled = busy || Boolean(isRecording) || isMicSession;
  controls.stop.disabled = busy || !isVideoRecording;
  controls.source.disabled = busy || session !== null;
  const isDisplay = controls.source.value === 'display';
  controls.pickRecRegion.disabled = busy || session !== null || isDisplay;
  controls.pickRecElement.disabled = busy || session !== null || isDisplay;
  controls.clearRecArea.disabled = busy || session !== null || pendingRecPick === null;
  controls.recAreaInfo.textContent = pendingRecPick
    ? `範囲: ${Math.round(pendingRecPick.rect.width)}×${Math.round(pendingRecPick.rect.height)}`
    : '範囲: 全体';

  controls.micStart.disabled = busy || Boolean(isRecording) || isVideoSession;
  controls.micStop.disabled = busy || !isMicRecording;

  controls.arm.disabled = busy || selectedTabId === null;
  controls.disarm.disabled = busy || armedTabId === null;

  controls.recordBadge.className = `status-badge${isVideoRecording ? ' recording' : isVideoSession ? ' active' : ''}`;
  controls.recordBadge.textContent = isVideoRecording ? '● 録画中' : isVideoSession ? '準備OK' : '待機中';

  controls.micBadge.className = `status-badge${isMicRecording ? ' recording' : ''}`;
  controls.micBadge.textContent = isMicRecording ? '● 録音中' : '待機中';

  controls.armedBadge.className = `status-badge${armedTabId !== null ? ' active' : ''}`;
  controls.armedBadge.textContent = armedTabId !== null ? 'ON' : 'OFF';

  if (session?.startedAt && isVideoRecording) {
    const seconds = Math.floor((Date.now() - session.startedAt) / 1000);
    controls.recordInfo.textContent = `録画中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  } else if (isVideoSession) {
    controls.recordInfo.textContent = '準備OK（トリガー待機中）';
  } else {
    controls.recordInfo.textContent = 'WebM 形式で保存';
  }

  if (session?.startedAt && isMicRecording) {
    const seconds = Math.floor((Date.now() - session.startedAt) / 1000);
    controls.micInfo.textContent = `録音中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  } else {
    controls.micInfo.textContent = 'WAV 形式で保存';
  }
}

async function refreshTabs(): Promise<void> {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter(tab => tab.id !== undefined);
  const old = selectedTabId;
  const current = tabs.find(tab => tab.id === old) ?? tabs.find(tab => tab.active) ?? tabs[0];
  selectedTabId = current?.id ?? null;
  controls.target.replaceChildren();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = `${tab.active ? '● ' : ''}${tab.title?.slice(0, 68) || tab.url || `Tab ${tab.id}`}`;
    controls.target.append(option);
  }
  controls.target.value = selectedTabId === null ? '' : String(selectedTabId);
  $('tab-info').textContent = current?.url || '対象がありません';
  updateControls();
}

async function activateTarget(): Promise<void> {
  const targetId = tabId();
  const tab = await chrome.tabs.get(targetId);
  if (!tab.active) await chrome.tabs.update(targetId, { active: true });
}

async function injectPicker(mode: 'element' | 'region'): Promise<PickResult> {
  await activateTarget();
  await chrome.scripting.executeScript({ target: { tabId: tabId() }, files: ['content.js'] });
  status('ページ上で選択してください。Escapeでキャンセル。');
  const response = await chrome.tabs.sendMessage<PickResult>(tabId(), { type: 'PICK', mode });
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function screenshot(mode: 'viewport' | 'region' | 'element'): Promise<void> {
  if (mode === 'viewport') {
    await activateTarget();
    const filename = await send<string>({ type: 'CAPTURE', tabId: tabId(), prefix: 'viewport' });
    status(`保存: ${filename}`);
    return;
  }
  const picked = await injectPicker(mode);
  const filename = await send<string>({ type: 'CAPTURE', tabId: tabId(), rect: picked.rect, viewport: picked.viewport, prefix: mode });
  if (picked.selector) controls.selector.value = picked.selector;
  status(`保存: ${filename}`);
}

function cleanSession(): void {
  const previous = session;
  session = null;
  previous?.cleanupCrop?.();
  previous?.stream.getTracks().forEach(track => track.stop());
  previous?.rawStream?.getTracks().forEach(track => track.stop());
  if (previous?.monitor) void previous.monitor.close();
  updateControls();
}

async function chooseDesktopStream(sources: chrome.desktopCapture.DesktopCaptureSourceType[]): Promise<MediaStream> {
  const chosen = await new Promise<{ streamId: string; canRequestAudioTrack: boolean }>((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(sources, (streamId, options) => {
      if (!streamId) {
        reject(new Error('共有がキャンセルされました。'));
        return;
      }
      resolve({ streamId, canRequestAudioTrack: Boolean(options?.canRequestAudioTrack) });
    });
  });
  const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: chosen.streamId } };
  const audio = chosen.canRequestAudioTrack
    ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: chosen.streamId } }
    : false;
  return navigator.mediaDevices.getUserMedia({
    video: video as unknown as MediaTrackConstraints,
    audio: audio as unknown as MediaTrackConstraints | boolean,
  });
}

async function syncRecordGuide(rect: BoxRect | null, targetTabId = pendingRecTabId ?? selectedTabId, selector?: string): Promise<void> {
  if (targetTabId === null) return;
  try {
    await chrome.tabs.sendMessage(targetTabId, { type: 'SET_RECORD_GUIDE', rect, ...(selector ? { selector } : {}) });
  } catch {
    /* ignore if tab was closed or cannot receive messages */
  }
}

async function createCroppedStream(
  rawStream: MediaStream,
  initialRect: BoxRect,
  initialViewport: ViewSize,
): Promise<{ stream: MediaStream; cleanup: () => void; updateRegion: (rect: BoxRect, viewport: ViewSize) => void }> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = rawStream;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanupListeners(); reject(new Error('映像ストリームの待機がタイムアウトしました。')); }, 5000);
      const onLoaded = (): void => { cleanupListeners(); resolve(); };
      const onError = (): void => { cleanupListeners(); reject(new Error('映像ストリームの読み込みに失敗しました。')); };
      const cleanupListeners = (): void => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
    });
    await video.play();
    let cropRect = initialRect;
    let cropViewport = initialViewport;
    let clipped = clampCaptureRect(cropRect, cropViewport, { width: video.videoWidth, height: video.videoHeight });
    if (!clipped) throw new Error('選択範囲が画面の外にあります。');
    const canvas = document.createElement('canvas');
    canvas.width = clipped.width;
    canvas.height = clipped.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('録画用の描画コンテキストを作成できません。');
    const updateRegion = (rect: BoxRect, viewport: ViewSize): void => {
      cropRect = rect;
      cropViewport = viewport;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const next = clampCaptureRect(cropRect, cropViewport, { width: video.videoWidth, height: video.videoHeight });
        if (next) clipped = next;
      }
    };
    const drawFrame = (): void => {
      if (video.readyState >= 2 && clipped) {
        ctx.drawImage(video, clipped.x, clipped.y, clipped.width, clipped.height, 0, 0, canvas.width, canvas.height);
      }
    };
    drawFrame();
    const timer = window.setInterval(drawFrame, 1000 / 30);
    const croppedStream = canvas.captureStream(30);
    for (const track of rawStream.getAudioTracks()) croppedStream.addTrack(track);
    return {
      stream: croppedStream,
      updateRegion,
      cleanup: () => {
        window.clearInterval(timer);
        video.pause();
        video.srcObject = null;
      },
    };
  } catch (error) {
    video.pause();
    video.srcObject = null;
    rawStream.getTracks().forEach(t => t.stop());
    throw error;
  }
}

async function prepare(sourceOverride?: CaptureSource): Promise<void> {
  if (session) throw new Error('先に現在のソースを解放してください。');
  const source = sourceOverride ?? (controls.source.value as CaptureSource);
  const picked = source === 'mic' ? null : pendingRecPick;
  if (picked && source === 'display') throw new Error('範囲・DOM要素の録画は「現在のタブ」または「タブを選択」でのみ利用できます。');
  if (picked && pendingRecTabId !== null && pendingRecTabId !== tabId()) {
    throw new Error('録画範囲を指定したタブと対象タブが異なります。対象タブを合わせるか「全体に戻す」を押してください。');
  }
  let stream: MediaStream;
  let rawStream: MediaStream | undefined;
  let cleanupCrop: (() => void) | undefined;
  let monitor: AudioContext | undefined;
  if (source === 'current-tab') {
    await activateTarget();
    let id: string;
    try {
      id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId() });
    } catch (error) {
      const detail = humanError(error);
      if (detail.includes('activeTab') || detail.includes('invoked')) {
        throw new Error('このタブではまだ「現在のタブ」の録画権限が有効になっていません。対象タブ上で右上のアイコンを押すか、「タブを選択」を使用してください。');
      }
      throw error;
    }
    const audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } };
    const video = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } };
    stream = await navigator.mediaDevices.getUserMedia({ audio: audio as unknown as MediaTrackConstraints, video: video as unknown as MediaTrackConstraints });
    if (stream.getAudioTracks().length) {
      monitor = new AudioContext();
      const input = monitor.createMediaStreamSource(stream);
      input.connect(monitor.destination);
      await monitor.resume();
    }
  } else if (source === 'tab') {
    stream = await chooseDesktopStream(['tab', 'audio']);
  } else if (source === 'display') {
    stream = await chooseDesktopStream(['screen', 'window', 'audio']);
  } else {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (detail.includes('NotAllowedError') || detail.includes('Permission')) {
        controls.grantMic.hidden = false;
        await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?grantMic=1') });
        throw new Error('開いたタブでマイクを「許可」してください（許可後タブは自動で閉じます）。その後もう一度「● 録音」を押してください。');
      }
      throw new Error(`マイク権限を取得できませんでした (${detail})`);
    }
  }
  controls.grantMic.hidden = true;
  let updateCrop: ((rect: BoxRect, viewport: ViewSize) => void) | undefined;
  if (picked) {
    rawStream = stream;
    try {
      const cropped = await createCroppedStream(rawStream, picked.rect, picked.viewport);
      stream = cropped.stream;
      cleanupCrop = cropped.cleanup;
      updateCrop = cropped.updateRegion;
    } catch (e) {
      if (monitor) void monitor.close();
      throw e;
    }
  }
  const nextSession: StreamSession = {
    source,
    stream,
    chunks: [],
    ...(rawStream ? { rawStream } : {}),
    ...(cleanupCrop ? { cleanupCrop } : {}),
    ...(updateCrop ? { updateCrop } : {}),
    ...(source === 'current-tab' ? { tabId: tabId() } : {}),
  };
  if (monitor) nextSession.monitor = monitor;
  session = nextSession;
  const watchedTracks = rawStream ? rawStream.getTracks() : stream.getTracks();
  for (const track of watchedTracks) {
    track.addEventListener('ended', () => {
      if (session !== nextSession) return;
      if (nextSession.recorder?.state === 'recording') {
        nextSession.recorder.stop();
      } else {
        cleanSession(); status('共有ストリームが終了しました。');
      }
    });
  }
  status('ソースを準備しました。');
  await addLog('prepared', source);
}

function supportedMime(audioOnly: boolean): string {
  const choices = audioOnly
    ? ['audio/webm;codecs=opus', 'audio/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return choices.find(value => MediaRecorder.isTypeSupported(value)) ?? '';
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const dataSize = length * channels * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, ch) => buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch]?.[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

async function blobToWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return encodeWav(decoded);
  } finally {
    await ctx.close();
  }
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const objectURL = URL.createObjectURL(blob);
  blobURLs.add(objectURL);
  try { await chrome.downloads.download({ url: objectURL, filename, saveAs: saveSettings.saveAs }); }
  catch (e) { URL.revokeObjectURL(objectURL); blobURLs.delete(objectURL); throw e; }
  // Keep URLs alive while Chrome is reading them. Revoke on panel unload instead of immediately.
}

async function startRecording(trigger?: TriggerFired, sourceOverride?: CaptureSource): Promise<void> {
  if (!session) {
    if (trigger) throw new Error('DOMトリガーで自動録画するには、先に「事前準備」を押してください。');
    await prepare(sourceOverride);
  }
  const active = session;
  if (!active) throw new Error('録画ソースの準備に失敗しました。');
  if (active.recorder?.state === 'recording') return;
  if (trigger && active.tabId !== undefined && active.tabId !== trigger.tabId) throw new Error('DOMトリガーのタブと収録タブが一致しません。');
  if (!active.stream.active) throw new Error('収録ストリームが終了しています。');
  const audioOnly = active.stream.getVideoTracks().length === 0;
  const mime = supportedMime(audioOnly);
  const recorder = new MediaRecorder(active.stream, mime ? { mimeType: mime } : undefined);
  active.chunks = [];
  active.recorder = recorder;
  const startedAt = Date.now();
  active.startedAt = startedAt;
  recorder.ondataavailable = event => { if (event.data.size) active.chunks.push(event.data); };
  recorder.onerror = () => { status('録画エラーが発生しました。', true); };
  recorder.onstop = () => {
    void (async () => {
      try {
        const timestamp = active.startedAt ?? Date.now();
        const blob = new Blob(active.chunks, { type: recorder.mimeType || (audioOnly ? 'audio/webm' : 'video/webm') });
        if (blob.size > 0) {
          let outBlob = blob;
          let ext: 'wav' | 'webm' = 'webm';
          if (audioOnly) {
            try {
              outBlob = await blobToWav(blob);
              ext = 'wav';
            } catch {
              outBlob = blob;
              ext = 'webm';
            }
          }
          const file = exportFilename(audioOnly ? 'audio' : 'video', timestamp, ext, saveSettings.saveFolder);
          await saveBlob(outBlob, file);
          await addLog('saved', `${file} (${Math.round(outBlob.size / 1024)} KiB)`);
          status(`保存: ${file}`);
        } else {
          await addLog('error', '録画データが空でした');
          status('録画データが空です。', true);
        }
      } finally {
        if (session === active && (audioOnly || !active.stream.active)) cleanSession();
      }
    })().catch(error => status(humanError(error), true)).finally(updateControls);
  };
  recorder.start(250);
  await addLog('record-start', trigger ? `DOM: ${trigger.rule.selector}` : '手動開始', trigger?.timestamp ?? startedAt, trigger?.tabId, trigger?.rule.selector);
  status('録画中'); updateControls();
}

async function stopRecording(trigger?: TriggerFired): Promise<void> {
  if (session?.recorder?.state !== 'recording') return;
  session.recorder.stop();
  await addLog('record-stop', trigger ? `DOM: ${trigger.rule.selector}` : '手動停止', trigger?.timestamp ?? Date.now(), trigger?.tabId, trigger?.rule.selector);
  updateControls();
}

function validateRule(): TriggerRule {
  const selector = controls.selector.value.trim();
  if (!selector || selector.length > 500) throw new Error('セレクタを1〜500文字で入力してください。');
  // document.querySelector validates syntax locally, even when no matching node exists.
  document.querySelector(selector);
  return {
    selector,
    when: controls.when.value as TriggerWhen,
    action: controls.action.value as TriggerAction,
    crop: controls.crop.checked,
  };
}

async function armTrigger(): Promise<void> {
  const rule = validateRule();
  await activateTarget();
  await send({ type: 'ARM_TRIGGER', tabId: tabId(), rule });
  armedTabId = tabId();
  status(`監視中: ${rule.selector}`);
}

async function disarmTrigger(): Promise<void> {
  if (armedTabId === null) return;
  await send({ type: 'DISARM_TRIGGER', tabId: armedTabId });
  armedTabId = null;
  status('監視を停止しました。');
}

function wire(): void {
  $('refresh-tabs').addEventListener('click', () => void run(refreshTabs));
  controls.target.addEventListener('change', () => {
    selectedTabId = Number(controls.target.value);
    void run(async () => {
      await activateTarget();
      const tab = await chrome.tabs.get(tabId());
      $('tab-info').textContent = tab.url ?? '';
    });
  });
  $('shot-view').addEventListener('click', () => void run(() => screenshot('viewport')));
  $('shot-region').addEventListener('click', () => void run(() => screenshot('region')));
  $('shot-element').addEventListener('click', () => void run(() => screenshot('element')));
  $('pick-selector').addEventListener('click', () => void run(async () => {
    const picked = await injectPicker('element');
    controls.selector.value = picked.selector ?? '';
    status(`選択: ${picked.selector ?? ''}`);
  }));
  controls.source.addEventListener('change', () => {
    if (controls.source.value === 'display' && pendingRecPick) {
      void syncRecordGuide(null);
      pendingRecPick = null;
      pendingRecTabId = null;
    }
    updateControls();
  });
  const pickRecordArea = async (mode: 'region' | 'element'): Promise<void> => {
    await syncRecordGuide(null);
    const targetId = tabId();
    const picked = await injectPicker(mode);
    pendingRecPick = picked;
    pendingRecTabId = targetId;
    await syncRecordGuide(picked.rect, targetId, picked.selector);
    if (picked.selector) controls.selector.value = picked.selector;
    status(`録画範囲を設定: ${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`);
  };
  controls.pickRecRegion.addEventListener('click', () => void run(() => pickRecordArea('region')));
  controls.pickRecElement.addEventListener('click', () => void run(() => pickRecordArea('element')));
  controls.clearRecArea.addEventListener('click', () => {
    void syncRecordGuide(null);
    pendingRecPick = null;
    pendingRecTabId = null;
    updateControls();
    status('録画範囲を「全体」に戻しました。');
  });
  controls.prepare.addEventListener('click', () => void run(() => prepare()));
  controls.grantMic.addEventListener('click', () => void run(async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?grantMic=1') });
    status('開いたタブでマイクを許可したあと、再度「● 録音」を押してください。');
  }));
  controls.release.addEventListener('click', () => { cleanSession(); status('ソースを解放しました。'); });
  controls.start.addEventListener('click', () => void run(() => startRecording()));
  controls.stop.addEventListener('click', () => void run(() => stopRecording()));
  controls.micStart.addEventListener('click', () => void run(() => startRecording(undefined, 'mic')));
  controls.micStop.addEventListener('click', () => void run(() => stopRecording()));
  controls.arm.addEventListener('click', () => void run(armTrigger));
  controls.disarm.addEventListener('click', () => void run(disarmTrigger));
  $('export-log').addEventListener('click', () => void run(async () => {
    const file = exportFilename('events', Date.now(), 'json', saveSettings.saveFolder);
    await saveBlob(new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' }), file);
    status(`保存: ${file}`);
  }));
  const persistSettings = async (): Promise<void> => {
    saveSettings = {
      saveFolder: sanitizeSaveFolder(controls.saveFolder.value),
      saveAs: controls.saveAs.checked,
    };
    controls.saveFolder.value = saveSettings.saveFolder;
    await chrome.storage.local.set({ [SETTINGS_KEY]: saveSettings });
    status(saveSettings.saveAs ? '保存時に毎回ダイアログを開きます。' : `保存先: ダウンロード/${saveSettings.saveFolder}`);
  };
  controls.saveFolder.addEventListener('change', () => void run(persistSettings));
  controls.saveAs.addEventListener('change', () => void run(persistSettings));
  chrome.runtime.onMessage.addListener((message, sender, _respond) => {
    if (message.type === 'RECORD_GUIDE_MOVED') {
      if (sender.tab?.id === undefined || sender.tab.id !== pendingRecTabId || !pendingRecPick) return;
      pendingRecPick = { ...pendingRecPick, rect: message.rect, viewport: message.viewport };
      session?.updateCrop?.(message.rect, message.viewport);
      updateControls();
      return;
    }
    if (message.type !== 'TRIGGER_FIRED') return;
    // The background service worker logs the event and handles screenshot actions.
    if (message.rule.action === 'start' || message.rule.action === 'stop' || message.rule.action === 'mark') {
      void (async () => {
        try {
          if (message.rule.action === 'start') await startRecording(message);
          else if (message.rule.action === 'stop') await stopRecording(message);
          else await addLog('marker', `DOM: ${message.rule.selector}`, message.timestamp, message.tabId, message.rule.selector);
        } catch (error) {
          await addLog('error', humanError(error), message.timestamp, message.tabId, message.rule.selector);
          status(humanError(error), true);
        }
      })();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (EVENTS_KEY in changes) {
      events = Array.isArray(changes[EVENTS_KEY]?.newValue) ? changes[EVENTS_KEY]?.newValue as EventRecord[] : [];
      renderEvents();
    }
    if (ARMED_KEY in changes) {
      const rule = changes[ARMED_KEY]?.newValue as ArmedRule | undefined;
      armedTabId = rule?.tabId ?? null;
      updateControls();
    }
  });
  window.addEventListener('beforeunload', () => {
    void syncRecordGuide(null);
    session?.stream.getTracks().forEach(track => track.stop());
    for (const url of blobURLs) URL.revokeObjectURL(url);
  });
  window.setInterval(() => { if (session?.recorder?.state === 'recording') updateControls(); }, 1000);
}

async function init(): Promise<void> {
  if (new URLSearchParams(location.search).get('grantMic') === '1') {
    const main = document.querySelector('main');
    if (main) {
      main.replaceChildren();
      const card = document.createElement('section');
      card.className = 'card';
      const title = document.createElement('h2');
      title.textContent = 'マイク権限の許可';
      const desc = document.createElement('p');
      desc.className = 'muted';
      desc.textContent = '上のダイアログで「許可」を押すと、このタブは自動で閉じます。';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = '再試行する';
      btn.hidden = true;
      const requestMic = async (): Promise<void> => {
        btn.hidden = true;
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          s.getTracks().forEach(t => t.stop());
          status('マイクを許可しました。');
          const tab = await chrome.tabs.getCurrent();
          if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
          else window.close();
        } catch (e) {
          btn.hidden = false;
          status(humanError(e), true);
        }
      };
      btn.addEventListener('click', () => { void requestMic(); });
      card.append(title, desc, btn);
      main.append(card);
      void requestMic();
    }
    return;
  }
  wire();
  const data = await chrome.storage.local.get([EVENTS_KEY, ARMED_KEY, SETTINGS_KEY]);
  events = Array.isArray(data[EVENTS_KEY]) ? data[EVENTS_KEY] as EventRecord[] : [];
  const armed = data[ARMED_KEY] as ArmedRule | undefined;
  const rawSettings = data[SETTINGS_KEY] as Partial<SaveSettings> | undefined;
  saveSettings = {
    saveFolder: sanitizeSaveFolder(typeof rawSettings?.saveFolder === 'string' ? rawSettings.saveFolder : undefined),
    saveAs: Boolean(rawSettings?.saveAs),
  };
  controls.saveFolder.value = saveSettings.saveFolder;
  controls.saveAs.checked = saveSettings.saveAs;
  armedTabId = armed?.tabId ?? null;
  if (armed) {
    controls.selector.value = armed.rule.selector;
    controls.when.value = armed.rule.when;
    controls.action.value = armed.rule.action;
    controls.crop.checked = armed.rule.crop;
  }
  renderEvents();
  await refreshTabs();
  updateControls();
}

void init().catch(error => status(humanError(error), true));
