export type TimeRangeKey = "today" | "7d" | "14d" | "30d" | "all" | "custom";

const DAY_MS = 86_400_000;

/// Compute the [start, end] unix-ms bounds for a range preset. "today" is
/// local-midnight aware and bounded to the local day so future-dated events do
/// not leak into today's dashboard charts.
export function rangeBounds(
  range: TimeRangeKey,
  customStart?: string,
  customEnd?: string,
  now: number = Date.now(),
): { start: number | null; end: number | null } {
  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start: start.getTime(), end: start.getTime() + DAY_MS - 1 };
    }
    case "7d":
      return { start: now - 7 * DAY_MS, end: now };
    case "14d":
      return { start: now - 14 * DAY_MS, end: now };
    case "30d":
      return { start: now - 30 * DAY_MS, end: now };
    case "all":
      return { start: null, end: null };
    case "custom":
      return {
        start: customStart ? new Date(customStart).getTime() : null,
        end: customEnd ? new Date(customEnd).getTime() : null,
      };
  }
}
