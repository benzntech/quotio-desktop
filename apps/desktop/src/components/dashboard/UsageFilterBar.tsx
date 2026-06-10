import type { UsageFilterOptions, UsageStatusFilter } from "../../types";
import type { TimeRangeKey, UsageFilters } from "../../state/usageDashboard";
import { Select, type SelectOption } from "../Select";
import { RefreshIcon } from "../icons";
import { maskEmail } from "../../lib/format";
import { useT } from "../../i18n";

type UsageFilterBarProps = {
  range: TimeRangeKey;
  onRangeChange: (range: TimeRangeKey) => void;
  customStart: string;
  onCustomStartChange: (value: string) => void;
  customEnd: string;
  onCustomEndChange: (value: string) => void;
  filters: UsageFilters;
  onFiltersChange: (filters: UsageFilters) => void;
  options: UsageFilterOptions;
  autoRefreshSec: number;
  onAutoRefreshChange: (seconds: number) => void;
  onRefresh: () => void;
  loading: boolean;
  hasActiveFilters: boolean;
  onReset: () => void;
};

const RANGE_KEYS: TimeRangeKey[] = ["today", "7d", "14d", "30d", "all", "custom"];
const AUTO_REFRESH_SECONDS = [0, 5, 10, 30, 60];

export function UsageFilterBar({
  range,
  onRangeChange,
  customStart,
  onCustomStartChange,
  customEnd,
  onCustomEndChange,
  filters,
  onFiltersChange,
  options,
  autoRefreshSec,
  onAutoRefreshChange,
  onRefresh,
  loading,
  hasActiveFilters,
  onReset,
}: UsageFilterBarProps) {
  const t = useT();

  const setFilter = (patch: Partial<UsageFilters>) => onFiltersChange({ ...filters, ...patch });

  const withAll = (label: string, values: string[], render?: (value: string) => string): SelectOption[] => [
    { value: "", label },
    ...values.map((value) => ({ value, label: render ? render(value) : value })),
  ];

  const apiKeyOptions: SelectOption[] = [
    { value: "", label: t("dash.filter.allApiKeys") },
    ...options.api_keys.map((key) => ({
      value: key.hash,
      label: key.alias ?? `${key.hash.slice(0, 8)}…`,
    })),
  ];

  const statusOptions: SelectOption[] = [
    { value: "all", label: t("dash.filter.allStatus") },
    { value: "success", label: t("dash.status.success") },
    { value: "failed", label: t("dash.status.failed") },
  ];

  const autoRefreshOptions: SelectOption[] = AUTO_REFRESH_SECONDS.map((seconds) => ({
    value: String(seconds),
    label: seconds === 0 ? t("dash.autoRefresh.off") : `${seconds}${t("dash.seconds")}`,
  }));

  return (
    <article className="panel usage-filter-bar">
      <div className="usage-filter-top">
        <div className="range-tabs" role="tablist" aria-label={t("dash.timeRange")}>
          {RANGE_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={range === key}
              className={range === key ? "range-tab range-tab--active" : "range-tab"}
              onClick={() => onRangeChange(key)}
            >
              {t(`dash.range.${key}`)}
            </button>
          ))}
        </div>
        <div className="usage-filter-actions">
          <span className="auto-refresh">
            <span className="auto-refresh-label">{t("dash.autoRefresh")}</span>
            <Select
              value={String(autoRefreshSec)}
              options={autoRefreshOptions}
              onChange={(value) => onAutoRefreshChange(Number(value))}
              minWidth="92px"
            />
          </span>
          <button
            type="button"
            className={loading ? "secondary-action secondary-action--busy" : "secondary-action"}
            onClick={onRefresh}
          >
            <RefreshIcon />
            <span>{t("common.refresh")}</span>
          </button>
        </div>
      </div>

      {range === "custom" ? (
        <div className="custom-range-row">
          <input
            type="datetime-local"
            value={customStart}
            onChange={(event) => onCustomStartChange(event.target.value)}
            aria-label={t("dash.range.start")}
          />
          <span className="custom-range-sep">→</span>
          <input
            type="datetime-local"
            value={customEnd}
            onChange={(event) => onCustomEndChange(event.target.value)}
            aria-label={t("dash.range.end")}
          />
        </div>
      ) : null}

      <div className="usage-filter-row">
        <Select
          value={filters.account}
          options={withAll(t("dash.filter.allAccounts"), options.accounts, maskEmail)}
          onChange={(value) => setFilter({ account: value })}
          minWidth="160px"
        />
        <Select
          value={filters.provider}
          options={withAll(t("dash.filter.allProviders"), options.providers)}
          onChange={(value) => setFilter({ provider: value })}
          minWidth="150px"
        />
        <Select
          value={filters.model}
          options={withAll(t("dash.filter.allModels"), options.models)}
          onChange={(value) => setFilter({ model: value })}
          minWidth="150px"
        />
        <Select
          value={filters.channel}
          options={withAll(t("dash.filter.allChannels"), options.channels)}
          onChange={(value) => setFilter({ channel: value })}
          minWidth="140px"
        />
        <Select
          value={filters.apiKeyHash}
          options={apiKeyOptions}
          onChange={(value) => setFilter({ apiKeyHash: value })}
          minWidth="160px"
        />
        <Select
          value={filters.status}
          options={statusOptions}
          onChange={(value) => setFilter({ status: value as UsageStatusFilter })}
          minWidth="120px"
        />
      </div>

      <div className="usage-search-row">
        <div className="usage-search">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            type="text"
            value={filters.search}
            placeholder={t("dash.searchPlaceholder")}
            onChange={(event) => setFilter({ search: event.target.value })}
          />
        </div>
        <button
          type="button"
          className="ghost-action"
          onClick={onReset}
          disabled={!hasActiveFilters}
        >
          {t("dash.clearFilters")}
        </button>
      </div>
    </article>
  );
}
