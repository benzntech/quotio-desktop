import { useMemo, useState } from "react";
import type { AccountSummaryRow } from "../../types";
import { Select, type SelectOption } from "../Select";
import { RefreshIcon } from "../icons";
import { formatCompactNumber, formatCost, formatRelativeTime, maskEmail } from "../../lib/format";
import { useT } from "../../i18n";

type AccountSummaryPanelProps = {
  rows: AccountSummaryRow[];
  loading: boolean;
  onRefresh: () => void;
  onPickAccount: (account: string) => void;
  onManagePrices: () => void;
};

type SortKey = "cost" | "requests" | "tokens" | "recent" | "successRate";
type ViewMode = "table" | "card";

function statusTone(row: AccountSummaryRow): "good" | "warn" | "bad" | "neutral" {
  if (row.total_requests === 0) return "neutral";
  if (row.success_rate >= 90) return "good";
  if (row.success_rate >= 50) return "warn";
  return "bad";
}

function sortRows(rows: AccountSummaryRow[], key: SortKey): AccountSummaryRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    switch (key) {
      case "cost":
        return (b.estimated_cost ?? 0) - (a.estimated_cost ?? 0);
      case "requests":
        return b.total_requests - a.total_requests;
      case "tokens":
        return b.total_tokens - a.total_tokens;
      case "recent":
        return b.last_request_ms - a.last_request_ms;
      case "successRate":
        return b.success_rate - a.success_rate;
    }
  });
  return sorted;
}

export function AccountSummaryPanel({
  rows,
  loading,
  onRefresh,
  onPickAccount,
  onManagePrices,
}: AccountSummaryPanelProps) {
  const t = useT();
  const [view, setView] = useState<ViewMode>("table");
  const [sortKey, setSortKey] = useState<SortKey>("requests");
  const [search, setSearch] = useState("");

  const sortOptions: SelectOption[] = [
    { value: "requests", label: t("dash.sort.requests") },
    { value: "cost", label: t("dash.sort.cost") },
    { value: "tokens", label: t("dash.sort.tokens") },
    { value: "successRate", label: t("dash.sort.successRate") },
    { value: "recent", label: t("dash.sort.recent") },
  ];

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = term
      ? rows.filter(
          (row) =>
            row.account.toLowerCase().includes(term) ||
            (row.provider ?? "").toLowerCase().includes(term),
        )
      : rows;
    return sortRows(filtered, sortKey);
  }, [rows, search, sortKey]);

  return (
    <article className="panel account-summary-panel">
      <div className="account-summary-head">
        <div className="account-summary-title">
          <span className="eyebrow">{t("dash.accountSummary")}</span>
          <span className="count-pill">{rows.length}</span>
        </div>
        <div className="account-summary-tools">
          <div className="usage-search usage-search--compact">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              type="text"
              value={search}
              placeholder={t("dash.searchAccount")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button
            type="button"
            className={loading ? "icon-button icon-button--spinning" : "icon-button"}
            onClick={onRefresh}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshIcon />
          </button>
          <span className="sort-control">
            <span className="sort-label">{t("dash.sortBy")}</span>
            <Select value={sortKey} options={sortOptions} onChange={(value) => setSortKey(value as SortKey)} minWidth="120px" />
          </span>
          <button type="button" className="ghost-action" onClick={onManagePrices}>
            {t("dash.managePrices")}
          </button>
          <div className="view-toggle">
            <button
              type="button"
              className={view === "table" ? "view-toggle-btn view-toggle-btn--active" : "view-toggle-btn"}
              onClick={() => setView("table")}
            >
              {t("dash.view.table")}
            </button>
            <button
              type="button"
              className={view === "card" ? "view-toggle-btn view-toggle-btn--active" : "view-toggle-btn"}
              onClick={() => setView("card")}
            >
              {t("dash.view.card")}
            </button>
          </div>
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <div className="account-summary-empty">
          <strong>{t("dash.empty.title")}</strong>
          <p>{t("dash.empty.hint")}</p>
        </div>
      ) : view === "table" ? (
        <div className="account-table-wrap">
          <table className="account-table">
            <thead>
              <tr>
                <th>{t("dash.col.account")}</th>
                <th>{t("dash.col.status")}</th>
                <th className="num">{t("dash.col.total")}</th>
                <th className="num">{t("dash.col.success")}</th>
                <th className="num">{t("dash.col.failed")}</th>
                <th className="num">{t("dash.col.successRate")}</th>
                <th className="num">{t("dash.col.tokens")}</th>
                <th className="num">{t("dash.col.cost")}</th>
                <th>{t("dash.col.lastRequest")}</th>
                <th>{t("dash.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={`${row.account}-${row.provider ?? ""}`}>
                  <td>
                    <div className="account-cell">
                      <span className="account-name">{maskEmail(row.account)}</span>
                      {row.provider ? <span className="account-provider">{row.provider}</span> : null}
                    </div>
                  </td>
                  <td>
                    <span className={`health-pill health-pill--${statusTone(row)}`}>
                      {t(`dash.health.${statusTone(row)}`)}
                    </span>
                  </td>
                  <td className="num">{formatCompactNumber(row.total_requests)}</td>
                  <td className="num">{formatCompactNumber(row.success_requests)}</td>
                  <td className="num">{formatCompactNumber(row.failed_requests)}</td>
                  <td className="num">{row.success_rate.toFixed(1)}%</td>
                  <td className="num">{formatCompactNumber(row.total_tokens)}</td>
                  <td className="num">{formatCost(row.estimated_cost)}</td>
                  <td>{formatRelativeTime(row.last_request_ms)}</td>
                  <td>
                    <button type="button" className="link-action" onClick={() => onPickAccount(row.account)}>
                      {t("dash.filterByAccount")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="acct-card-grid">
          {visibleRows.map((row) => (
            <div key={`${row.account}-${row.provider ?? ""}`} className="acct-card">
              <div className="acct-card-head">
                <span className="account-name">{maskEmail(row.account)}</span>
                <span className={`health-pill health-pill--${statusTone(row)}`}>
                  {t(`dash.health.${statusTone(row)}`)}
                </span>
              </div>
              {row.provider ? <span className="account-provider">{row.provider}</span> : null}
              <div className="acct-card-metrics">
                <div>
                  <dt>{t("dash.col.total")}</dt>
                  <dd>{formatCompactNumber(row.total_requests)}</dd>
                </div>
                <div>
                  <dt>{t("dash.col.successRate")}</dt>
                  <dd>{row.success_rate.toFixed(1)}%</dd>
                </div>
                <div>
                  <dt>{t("dash.col.tokens")}</dt>
                  <dd>{formatCompactNumber(row.total_tokens)}</dd>
                </div>
                <div>
                  <dt>{t("dash.col.cost")}</dt>
                  <dd>{formatCost(row.estimated_cost)}</dd>
                </div>
              </div>
              <div className="acct-card-foot">
                <span>{formatRelativeTime(row.last_request_ms)}</span>
                <button type="button" className="link-action" onClick={() => onPickAccount(row.account)}>
                  {t("dash.filterByAccount")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
