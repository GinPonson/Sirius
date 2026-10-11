/** 柱图最大高度（px）；柱高与当月照片数线性成正比。 */
const BAR_MAX_HEIGHT = 52;
/** 最小柱高（px）；零照片月份仍保留可点击的可见柱。 */
const BAR_MIN_HEIGHT = 5;
const BAR_WIDTH = 14;
const SVG_HEIGHT = BAR_MAX_HEIGHT + 4;

/** 将月份键（UTC YYYY-MM）渲染为本地年月标签。 */
export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return `${year} 年 ${month} 月`;
}

type AlbumMonthNavProps = {
  months: Array<{ monthKey: string; photoCount: number }>;
  /** 当前滚动停留的月份；对应柱高亮。 */
  activeMonthKey: string | null;
  onNavigate: (monthKey: string) => void;
};

/**
 * 相册年月导航：手写 SVG 柱图（不引图表库），每月一根柱、高度与当月照片数成正比，
 * 点击滚动定位到该月。柱图口径为「索引快照 · 文件修改时间」，在图注中诚实注明。
 */
export function AlbumMonthNav({ months, activeMonthKey, onNavigate }: AlbumMonthNavProps) {
  const maxCount = months.reduce((max, month) => Math.max(max, month.photoCount), 1);
  return (
    <nav className="albums-month-nav" aria-label="按月份定位时间线">
      <div className="albums-month-nav-bars">
        {months.map((month, index) => {
          const barHeight = Math.max(
            BAR_MIN_HEIGHT,
            Math.round((month.photoCount / maxCount) * BAR_MAX_HEIGHT),
          );
          const active = month.monthKey === activeMonthKey;
          const year = month.monthKey.slice(0, 4);
          const showYear = index === 0 || months[index - 1].monthKey.slice(0, 4) !== year;
          const tickLabel = `${showYear ? `${year}年` : ""}${Number(month.monthKey.slice(5, 7))}月`;
          const hint = `${monthLabel(month.monthKey)} · ${month.photoCount} 张 · 点击定位`;
          return (
            <button
              key={month.monthKey}
              className={active ? "active" : ""}
              title={hint}
              aria-label={hint}
              aria-current={active ? "true" : undefined}
              onClick={() => onNavigate(month.monthKey)}
            >
              <svg
                width={BAR_WIDTH + 2}
                height={SVG_HEIGHT}
                viewBox={`0 0 ${BAR_WIDTH + 2} ${SVG_HEIGHT}`}
                aria-hidden="true"
                focusable="false"
              >
                <rect
                  x={1}
                  y={SVG_HEIGHT - barHeight}
                  width={BAR_WIDTH}
                  height={barHeight}
                  rx={3}
                  fill={active ? "var(--primary)" : "var(--hairline-strong)"}
                />
              </svg>
              <span>{tickLabel}</span>
            </button>
          );
        })}
      </div>
      <p className="albums-month-nav-note">按索引快照 · 文件修改时间</p>
    </nav>
  );
}
