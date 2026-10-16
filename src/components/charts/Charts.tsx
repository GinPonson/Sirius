import type { ReactNode } from "react";

/**
 * 轻量图表组件集（手写 SVG，不引入图表库）。
 * 数据口径约定：所有数值必须来自真实查询或确定性统计，图注需注明范围与来源；
 * 不使用假数据，不在无数据时渲染占位图形。
 */

/** 容量分段条：已用 / 剩余，附数值标签。用于账户容量与文件类型占比。 */
export function StorageBar({
  used,
  total,
  usedLabel,
  totalLabel,
  ariaLabel,
}: {
  used: number;
  total: number;
  usedLabel: string;
  totalLabel: string;
  ariaLabel: string;
}) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <div className="chart-storage" role="meter" aria-label={ariaLabel} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className="chart-storage-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="chart-storage-legend">
        <span><i className="swatch used" aria-hidden="true" />已用 {usedLabel}</span>
        <span><i className="swatch free" aria-hidden="true" />剩余 {totalLabel}</span>
      </div>
    </div>
  );
}

export type SegmentDatum = {
  key: string;
  label: string;
  value: number;
  /** 语义色名：与状态色 token 对应（keep/rename/move/delete/done/failed/skipped）。 */
  tone: "primary" | "success" | "warn" | "danger" | "muted";
};

/** 分段条：按动作或结果分解数量；可点击分段筛选（onSelect）。 */
export function SegmentBar({
  data,
  ariaLabel,
  onSelect,
  activeKey,
}: {
  data: SegmentDatum[];
  ariaLabel: string;
  onSelect?: (key: string) => void;
  activeKey?: string | null;
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return null;
  return (
    <div className="chart-segments" aria-label={ariaLabel}>
      <div className="chart-segments-track">
        {data.filter((item) => item.value > 0).map((item) => (
          <button
            key={item.key}
            type="button"
            className={`chart-segment ${item.tone}${activeKey === item.key ? " active" : ""}`}
            style={{ flexGrow: item.value }}
            disabled={!onSelect}
            aria-label={`${item.label} ${item.value} 项`}
            aria-pressed={onSelect ? activeKey === item.key : undefined}
            onClick={onSelect ? () => onSelect(item.key) : undefined}
          >
            <span className="chart-segment-fill" />
          </button>
        ))}
      </div>
      <ul className="chart-segments-legend">
        {data.map((item) => (
          <li key={item.key} className={activeKey === item.key ? "active" : ""}>
            <i className={`swatch ${item.tone}`} aria-hidden="true" />
            {item.label} <strong>{item.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type MonthBarDatum = {
  monthKey: string;
  label: string;
  count: number;
};

/**
 * 月份柱图：兼作时间导航（点击滚动定位到该月）。
 * 口径注记由调用方给出（当前数据来自索引快照的文件修改时间，非拍摄时间）。
 */
export function MonthBars({
  data,
  ariaLabel,
  onSelect,
  activeMonthKey,
  caption,
}: {
  data: MonthBarDatum[];
  ariaLabel: string;
  onSelect?: (monthKey: string) => void;
  activeMonthKey?: string | null;
  caption?: ReactNode;
}) {
  const max = data.reduce((value, item) => Math.max(value, item.count), 0);
  if (max <= 0) return null;
  return (
    <div className="chart-months" aria-label={ariaLabel}>
      <div className="chart-months-bars">
        {data.map((item) => (
          <button
            key={item.monthKey}
            type="button"
            className={`chart-month${activeMonthKey === item.monthKey ? " active" : ""}`}
            aria-label={`${item.label} ${item.count} 张`}
            title={`${item.label} · ${item.count} 张`}
            onClick={onSelect ? () => onSelect(item.monthKey) : undefined}
            disabled={!onSelect}
          >
            <span style={{ height: `${Math.max(6, (item.count / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      {caption && <p className="chart-caption">{caption}</p>}
    </div>
  );
}
