import type { RecentRequestBucket } from "../types";
import { healthTone } from "../lib/format";

// Per-account health sparkline: one dot per recent-request bucket from the
// proxy's /auth-files response. Green = ok, amber = mixed, red = failed,
// gray = idle. Mirrors CLIProxyAPI's "健康状态" row.
export function HealthDots({ recent, compact }: { recent: RecentRequestBucket[]; compact?: boolean }) {
  if (recent.length === 0) return null;
  return (
    <div className={compact ? "health-dots health-dots--sm" : "health-dots"}>
      {recent.map((bucket, index) => (
        <span
          key={`${bucket.time}-${index}`}
          className={`health-dot health-dot--${healthTone(bucket)}`}
          title={`${bucket.time}  ✓${bucket.success} ✗${bucket.failed}`}
        />
      ))}
    </div>
  );
}
