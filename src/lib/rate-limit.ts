interface RateWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, RateWindow>();
const MAX_WINDOWS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
  windowMs: number;
}

export function buildKey(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p !== undefined && p !== "").join("|");
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  let window = windows.get(key);
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + windowMs };
    windows.set(key, window);
  }
  const allowed = window.count < limit;
  if (allowed) {
    window.count += 1;
  }
  pruneIfNeeded();
  return {
    allowed,
    remaining: Math.max(0, limit - window.count),
    resetAt: new Date(window.resetAt),
    limit,
    windowMs,
  };
}

function pruneIfNeeded(): void {
  if (windows.size <= MAX_WINDOWS) return;
  const now = Date.now();
  for (const [key, window] of windows) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}

export function resetRateLimits(): void {
  windows.clear();
}