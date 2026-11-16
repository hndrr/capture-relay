/** Minimal API declarations so this prototype builds without @types/chrome. */
type BoxRect = { x: number; y: number; width: number; height: number };
type ViewSize = { width: number; height: number };
type TriggerWhen = 'appear' | 'disappear' | 'click';
type TriggerAction = 'screenshot' | 'start' | 'stop' | 'mark';
type TriggerRule = { selector: string; when: TriggerWhen; action: TriggerAction; crop: boolean };
type ArmedRule = { tabId: number; rule: TriggerRule };
type SaveSettings = { saveFolder: string; saveAs: boolean };
type EventRecord = {
  id: string;
  timestamp: number;
  tabId?: number;
  selector?: string;
  kind: string;
  detail: string;
  recordingOffsetMs?: number;
};
type PickResult = { rect: BoxRect; viewport: ViewSize; selector?: string };
type TriggerFired = {
  type: 'TRIGGER_FIRED'; tabId: number; rule: TriggerRule;
  timestamp: number; rect?: BoxRect; viewport: ViewSize;
};
type ExtMessage =
  | { type: 'ARM_TRIGGER'; tabId: number; rule: TriggerRule }
  | { type: 'DISARM_TRIGGER'; tabId: number }
  | { type: 'CONFIGURE_RULE'; tabId: number; rule: TriggerRule | null }
  | { type: 'PICK'; mode: 'element' | 'region' }
  | { type: 'SET_RECORD_GUIDE'; rect: BoxRect | null; selector?: string }
  | { type: 'RECORD_GUIDE_MOVED'; rect: BoxRect; viewport: ViewSize }
  | { type: 'CAPTURE'; tabId: number; rect?: BoxRect; viewport?: ViewSize; prefix?: string }
  | { type: 'ADD_LOG'; record: EventRecord }
  | TriggerFired;
type ExtResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

declare namespace chrome {
  namespace runtime {
    type MessageSender = { tab?: tabs.Tab; id?: string };
    const onInstalled: { addListener(callback: () => void): void };
    const onMessage: {
      addListener(callback: (message: ExtMessage, sender: MessageSender, sendResponse: (response: ExtResponse) => void) => boolean | void): void;
    };
    function sendMessage<T = unknown>(message: ExtMessage): Promise<ExtResponse<T>>;
    function getURL(path: string): string;
  }
  namespace action {
    const onClicked: { addListener(callback: (tab: tabs.Tab) => void): void };
  }
  namespace sidePanel {
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
    function open(options: { windowId?: number; tabId?: number }): Promise<void>;
  }
  namespace tabs {
    type Tab = { id?: number; windowId: number; active: boolean; url?: string; title?: string; favIconUrl?: string };
    const onUpdated: { addListener(callback: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void): void };
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
    function query(options: { currentWindow?: boolean; active?: boolean; windowId?: number }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function update(tabId: number, options: { active: boolean }): Promise<Tab>;
    function create(options: { url: string }): Promise<Tab>;
    function getCurrent(): Promise<Tab | undefined>;
    function remove(tabIds: number | number[]): Promise<void>;
    function captureVisibleTab(windowId?: number, options?: { format?: 'png' | 'jpeg' }): Promise<string>;
    function sendMessage<T = unknown>(tabId: number, message: ExtMessage): Promise<ExtResponse<T>>;
  }
  namespace scripting {
    function executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  }
  namespace downloads {
    function download(options: { url: string; filename: string; saveAs?: boolean }): Promise<number>;
  }
  namespace tabCapture {
    function getMediaStreamId(options: { targetTabId?: number }): Promise<string>;
  }
  namespace desktopCapture {
    type DesktopCaptureSourceType = 'screen' | 'window' | 'tab' | 'audio';
    function chooseDesktopMedia(
      sources: DesktopCaptureSourceType[],
      callback: (streamId: string, options?: { canRequestAudioTrack?: boolean }) => void,
    ): number;
  }
  namespace storage {
    type StorageData = { [key: string]: unknown };
    const local: {
      get(keys?: string | string[]): Promise<StorageData>;
      set(items: StorageData): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    const onChanged: { addListener(callback: (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }, areaName: string) => void): void };
  }
}
