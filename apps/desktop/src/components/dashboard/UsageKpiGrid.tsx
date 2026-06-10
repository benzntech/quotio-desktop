import type { UsageAggregate } from "../../types";
import { formatCompactNumber, formatCost } from "../../lib/format";
import { useT } from "../../i18n";

type UsageKpiGridProps = {
  stats: UsageAggregate | null;
};

const EMPTY: UsageAggregate = {
  total_requests: 0,
  success_requests: 0,
  failed_requests: 0,
  success_rate: 0,
  account_count: 0,
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cached_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  input_token_ratio: 0,
  output_token_ratio: 0,
  cache_hit_rate: 0,
  avg_latency_ms: 0,
  estimated_cost: null,
  prices_configured: false,
};

type Card = {
  key: string;
  title: string;
  value: string;
  caption: string;
  tone: "blue" | "green" | "purple" | "orange" | "red";
  emphasis?: boolean;
};

export function UsageKpiGrid({ stats }: UsageKpiGridProps) {
  const t = useT();
  const s = stats ?? EMPTY;
  const noTraffic = s.total_requests === 0;

  const cards: Card[] = [
    {
      key: "total",
      title: t("dash.kpi.totalCalls"),
      value: formatCompactNumber(s.total_requests),
      caption: `${s.account_count} ${t("dash.accounts")}`,
      tone: "blue",
    },
    {
      key: "success",
      title: t("dash.kpi.successRate"),
      value: `${s.success_rate.toFixed(1)}%`,
      caption: noTraffic ? "--" : `${s.success_requests} ${t("dash.successful")}`,
      tone: noTraffic || s.success_rate >= 90 ? "green" : "orange",
      emphasis: true,
    },
    {
      key: "failed",
      title: t("dash.kpi.failures"),
      value: formatCompactNumber(s.failed_requests),
      caption: noTraffic ? "--" : `${t("dash.failRate")} ${(100 - s.success_rate).toFixed(1)}%`,
      tone: s.failed_requests > 0 ? "red" : "green",
    },
    {
      key: "cost",
      title: t("dash.kpi.cost"),
      value: formatCost(s.estimated_cost),
      caption: s.prices_configured ? t("dash.cost.configured") : t("dash.cost.unset"),
      tone: "orange",
    },
    {
      key: "totalTokens",
      title: t("dash.kpi.totalTokens"),
      value: formatCompactNumber(s.total_tokens),
      caption: `${t("dash.reasoning")} ${formatCompactNumber(s.reasoning_tokens)}`,
      tone: "purple",
    },
    {
      key: "inputTokens",
      title: t("dash.kpi.inputTokens"),
      value: formatCompactNumber(s.input_tokens),
      caption: `${t("dash.ratio")} ${s.input_token_ratio.toFixed(1)}%`,
      tone: "blue",
    },
    {
      key: "outputTokens",
      title: t("dash.kpi.outputTokens"),
      value: formatCompactNumber(s.output_tokens),
      caption: `${t("dash.ratio")} ${s.output_token_ratio.toFixed(1)}%`,
      tone: "green",
    },
    {
      key: "cacheTokens",
      title: t("dash.kpi.cacheTokens"),
      value: formatCompactNumber(s.cached_tokens),
      caption: `${t("dash.hitRate")} ${s.cache_hit_rate.toFixed(1)}%`,
      tone: "purple",
    },
  ];

  return (
    <section className="kpi-grid kpi-grid--usage">
      {cards.map((card) => (
        <article
          key={card.key}
          className={`kpi-card kpi-card--${card.tone}${card.emphasis ? " kpi-card--emphasis" : ""}`}
        >
          <div className="kpi-card-head">
            <span>{card.title}</span>
          </div>
          <strong>{card.value}</strong>
          <p>{card.caption}</p>
        </article>
      ))}
    </section>
  );
}
