/** Rectangle in CSS viewport coordinates -> clamped bitmap pixel coordinates. */
export function clampCaptureRect(
  rect: BoxRect,
  viewport: ViewSize,
  bitmap: ViewSize,
): BoxRect | null {
  if (
    ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, bitmap.width, bitmap.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0
    || viewport.width <= 0 || viewport.height <= 0
    || bitmap.width <= 0 || bitmap.height <= 0
  ) return null;
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const x1 = Math.max(0, Math.min(bitmap.width, Math.floor(rect.x * scaleX)));
  const y1 = Math.max(0, Math.min(bitmap.height, Math.floor(rect.y * scaleY)));
  const x2 = Math.max(0, Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * scaleX)));
  const y2 = Math.max(0, Math.min(bitmap.height, Math.ceil((rect.y + rect.height) * scaleY)));
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function sanitizeSaveFolder(folder?: string): string {
  const segments = (folder ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map(part => part.trim().replace(/[<>:"|?*\x00-\x1f]/g, '-'))
    .filter(part => part && part !== '.' && part !== '..');
  return segments.length ? segments.join('/') : 'capture-relay';
}

export function exportFilename(
  prefix: string,
  timestamp: number,
  extension: 'png' | 'webm' | 'wav' | 'json',
  folder = 'capture-relay',
): string {
  const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 36) || 'capture';
  return `${sanitizeSaveFolder(folder)}/${stamp}_${safe}.${extension}`;
}
