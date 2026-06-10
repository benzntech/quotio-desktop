import { useState } from "react";
import type { ModelPrice } from "../../types";
import { useT } from "../../i18n";

type ModelPricesDialogProps = {
  prices: ModelPrice[];
  knownModels: string[];
  onSave: (prices: ModelPrice[]) => Promise<unknown>;
  onClose: () => void;
};

type DraftRow = {
  model: string;
  prompt: string;
  completion: string;
  cache: string;
};

function toDraft(price: ModelPrice): DraftRow {
  return {
    model: price.model,
    prompt: String(price.prompt_per_1m),
    completion: String(price.completion_per_1m),
    cache: String(price.cache_per_1m),
  };
}

export function ModelPricesDialog({ prices, knownModels, onSave, onClose }: ModelPricesDialogProps) {
  const t = useT();
  const [rows, setRows] = useState<DraftRow[]>(
    prices.length > 0 ? prices.map(toDraft) : [{ model: "", prompt: "", completion: "", cache: "" }],
  );
  const [saving, setSaving] = useState(false);

  const update = (index: number, patch: Partial<DraftRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const addRow = () => setRows((current) => [...current, { model: "", prompt: "", completion: "", cache: "" }]);
  const removeRow = (index: number) => setRows((current) => current.filter((_, i) => i !== index));

  const unusedModels = knownModels.filter((model) => !rows.some((row) => row.model === model));

  async function save() {
    setSaving(true);
    try {
      const next: ModelPrice[] = rows
        .filter((row) => row.model.trim() !== "")
        .map((row) => ({
          model: row.model.trim(),
          prompt_per_1m: Number(row.prompt) || 0,
          completion_per_1m: Number(row.completion) || 0,
          cache_per_1m: Number(row.cache) || 0,
          source: "manual",
        }));
      await onSave(next);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="prices-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="prices-dialog-head">
          <strong>{t("dash.prices.title")}</strong>
          <p>{t("dash.prices.desc")}</p>
        </div>

        <div className="prices-table-wrap">
          <table className="prices-table">
            <thead>
              <tr>
                <th>{t("dash.prices.model")}</th>
                <th className="num">{t("dash.prices.prompt")}</th>
                <th className="num">{t("dash.prices.completion")}</th>
                <th className="num">{t("dash.prices.cache")}</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>
                    <input
                      type="text"
                      list="known-models"
                      value={row.model}
                      placeholder="gpt-5.5"
                      onChange={(event) => update(index, { model: event.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.prompt}
                      onChange={(event) => update(index, { prompt: event.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.completion}
                      onChange={(event) => update(index, { completion: event.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.cache}
                      onChange={(event) => update(index, { cache: event.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => removeRow(index)}
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="known-models">
            {unusedModels.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>

        <button type="button" className="ghost-action prices-add" onClick={addRow}>
          + {t("dash.prices.addRow")}
        </button>

        <div className="prices-dialog-actions">
          <button type="button" className="ghost-action" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="secondary-action" onClick={() => void save()} disabled={saving}>
            {saving ? t("dash.prices.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
