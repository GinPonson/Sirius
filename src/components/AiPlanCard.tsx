import { useState, type ReactNode } from "react";
import type {
  AiExecutionDetail,
  AiExecutionReport,
  AiOrganizationPlan,
  AiPlanItem,
} from "../services/aiServices";
import { Icon, type IconName } from "./Icon";
import { SegmentBar, type SegmentDatum } from "./charts/Charts";

/** 计划动作构成：与 AiPlanAction 一一对应，语义色沿用计划行既有约定。 */
const PLAN_SEGMENTS: Array<Omit<SegmentDatum, "value">> = [
  { key: "rename", label: "重命名", tone: "primary" },
  { key: "move", label: "移动", tone: "success" },
  { key: "delete", label: "删除", tone: "danger" },
  { key: "keep", label: "保持", tone: "muted" },
];

/** 方案卡状态机：分析中 → 可确认 → 执行中 → 结果；error 保留原因并允许重试。 */
export type PlanCardState = {
  phase: "analyzing" | "ready" | "executing" | "report" | "error";
  /** 分析成功后的整理计划；生成前或失败时为 null。 */
  plan: AiOrganizationPlan | null;
  /** 用户逐项勾选要执行的建议；删除项默认不勾选。 */
  selected: Set<string>;
  /** 执行报告；仅 report 阶段存在。 */
  report: AiExecutionReport | null;
  /** error 阶段的失败原因。 */
  message?: string;
  /** 发起分析的目标目录 ID；重试分析时复用，方案永远绑定原目录。 */
  folderId?: string;
  /** 发起分析时的目录名，用于展示绑定关系。 */
  folderName?: string;
};

function actionIcon(action: AiPlanItem["action"]): IconName {
  if (action === "rename") return "edit";
  if (action === "move") return "folder";
  if (action === "delete") return "trash";
  return "check";
}

function reportIcon(detail: AiExecutionDetail): IconName {
  if (detail.status === "done") return "check";
  if (detail.status === "failed") return "alert";
  return "history";
}

function actionLabel(
  item: Pick<AiPlanItem, "action"> & Partial<Pick<AiPlanItem, "suggestedName" | "targetFolder">>,
): ReactNode {
  if (item.action === "rename") return <span>重命名为 <em>{item.suggestedName || "—"}</em></span>;
  if (item.action === "move") return <span>移动到 <em>{item.targetFolder || "—"}</em></span>;
  if (item.action === "delete") return <span>移入回收站</span>;
  return <span>保持现状</span>;
}

type AiPlanCardProps = {
  state: PlanCardState;
  /** compact=面板内卡片；expanded=主内容区大表（沿用原计划表三列布局）。 */
  compact: boolean;
  onToggleItem: (fileId: string) => void;
  onExpand: () => void;
  onConfirm: () => void;
  onRetry: () => void;
};

/** 对话流内的整理方案卡：勾选对照表 + 展开检查 + 确认执行；执行后原位变结果卡。 */
export function AiPlanCard({ state, compact, onToggleItem, onExpand, onConfirm, onRetry }: AiPlanCardProps) {
  // 动作构成分段条的筛选状态；必须位于早退分支之前以保持 Hook 顺序稳定。
  const [actionFilter, setActionFilter] = useState<string | null>(null);

  if (state.phase === "analyzing") {
    return (
      <div className="ai-chat-plan-card" role="status">
        <span className="ai-chat-plan-spinner" aria-hidden="true" />
        <p>正在分析{state.folderName ? `“${state.folderName}”` : "当前目录"}，只读取文件名等基础信息…</p>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="ai-chat-plan-card ai-chat-plan-card-error" role="alert">
        <Icon name="alert" size={15} />
        <p>{state.message ?? "整理计划生成失败"}</p>
        <button type="button" className="ai-chat-btn" onClick={onRetry}>重试</button>
      </div>
    );
  }

  if (state.phase === "report" && state.report && state.plan) {
    return <AiReportCard report={state.report} folderName={state.folderName} />;
  }

  const plan = state.plan;
  if (!plan) return null;

  const executableItems = plan.items.filter((item) => item.action !== "keep");
  const selectedItems = plan.items.filter((item) => state.selected.has(item.fileId));
  const deleteCount = selectedItems.filter((item) => item.action === "delete").length;
  const executing = state.phase === "executing";

  return (
    <div className={`ai-chat-plan-card${compact ? "" : " ai-chat-plan-card-expanded"}`}>
      <header className="ai-chat-plan-head">
        <Icon name="sparkles" size={14} />
        <strong>整理计划 · {state.folderName ?? "当前目录"}</strong>
      </header>
      <p className="ai-chat-plan-summary">
        {plan.summary || "模型未提供总结"}
        {plan.truncated ? " · 目录较大，仅分析前 200 项" : ""} · {plan.analyzedCount} 项 · 模型 {plan.model}
      </p>

      {/* 动作构成分段条：点击分段筛选下方列表（口径=本次计划项，非整个目录） */}
      <SegmentBar
        data={PLAN_SEGMENTS.map((segment) => ({
          ...segment,
          value: plan.items.filter((item) => item.action === segment.key).length,
        }))}
        ariaLabel="整理计划动作构成"
        activeKey={actionFilter}
        onSelect={(key) => setActionFilter((current) => (current === key ? null : key))}
      />
      {actionFilter && (
        <p className="ai-chat-plan-filter-note">
          仅显示「{PLAN_SEGMENTS.find((segment) => segment.key === actionFilter)?.label}」项
          <button type="button" onClick={() => setActionFilter(null)}>清除筛选</button>
        </p>
      )}

      {plan.items.length === 0 ? (
        <div className="ai-chat-plan-empty">该目录已足够规范，模型没有提出调整建议。</div>
      ) : compact ? (
        <div className="ai-chat-plan-list">
          {plan.items.filter((item) => !actionFilter || item.action === actionFilter).map((item) => {
            const executable = item.action !== "keep";
            return (
              <article
                key={item.fileId}
                className={`ai-chat-plan-row ${item.action}${executable && state.selected.has(item.fileId) ? " selected" : ""}`}
              >
                <div className="ai-chat-plan-row-file">
                  {executable && (
                    <input
                      type="checkbox"
                      className="file-check"
                      aria-label={`选择执行 ${item.currentName}`}
                      checked={state.selected.has(item.fileId)}
                      disabled={executing}
                      onChange={() => onToggleItem(item.fileId)}
                    />
                  )}
                  <Icon name={actionIcon(item.action)} size={14} />
                  <strong title={item.currentName}>{item.currentName}</strong>
                </div>
                <div className="ai-chat-plan-row-change" title={item.reason || undefined}>
                  {actionLabel(item)}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="ai-plan-list">
          {plan.items.filter((item) => !actionFilter || item.action === actionFilter).map((item) => {
            const executable = item.action !== "keep";
            return (
              <article
                key={item.fileId}
                className={`ai-plan-item ${item.action}${executable && state.selected.has(item.fileId) ? " selected" : ""}`}
              >
                <div className="ai-plan-file">
                  {executable && (
                    <input
                      type="checkbox"
                      className="file-check"
                      aria-label={`选择执行 ${item.currentName}`}
                      checked={state.selected.has(item.fileId)}
                      disabled={executing}
                      onChange={() => onToggleItem(item.fileId)}
                    />
                  )}
                  <Icon name={actionIcon(item.action)} size={16} />
                  <strong>{item.currentName}</strong>
                </div>
                <div className="ai-plan-change">{actionLabel(item)}</div>
                <p>{item.reason || "—"}</p>
              </article>
            );
          })}
        </div>
      )}

      {executableItems.length > 0 && (
        <footer className="ai-chat-plan-footer">
          <span>
            已选 {selectedItems.length} 项{deleteCount > 0 ? `，其中 ${deleteCount} 项删除将进入回收站` : ""}
          </span>
          <div className="ai-chat-plan-actions">
            <button type="button" className="ai-chat-btn" disabled={executing} onClick={onExpand}>
              展开检查
            </button>
            <button type="button" className="ai-chat-btn ai-chat-btn-danger" disabled={selectedItems.length === 0 || executing} onClick={onConfirm}>
              {executing ? "正在执行…" : "确认执行"}
            </button>
          </div>
        </footer>
      )}
      <p className="ai-chat-plan-note">修改只在确认后执行；执行前系统会重新核对每个文件的当前状态。</p>
    </div>
  );
}

/** 执行结果卡：计数 + 逐项明细，失败项可直接看出原因。 */
function AiReportCard({ report, folderName }: { report: AiExecutionReport; folderName?: string }) {
  return (
    <div className="ai-chat-plan-card ai-chat-plan-report">
      <header className="ai-chat-plan-head">
        <Icon name="check" size={14} />
        <strong>整理结果 · {folderName ?? "原目录"}</strong>
      </header>
      <p className="ai-chat-plan-summary">
        已执行 {report.executed} · 跳过 {report.skipped} · 失败 {report.failed}
        {report.deletedToRecycleBin > 0 ? ` · ${report.deletedToRecycleBin} 项移入回收站` : ""}
        {report.createdFolders > 0 ? ` · 新建 ${report.createdFolders} 个文件夹` : ""}
      </p>
      {/* 结果构成分段条：三类互斥（删除项计入已执行，不重复相加），口径即明细行数 */}
      <SegmentBar
        data={[
          { key: "executed", label: "已执行", value: report.executed, tone: "success" },
          { key: "skipped", label: "跳过", value: report.skipped, tone: "muted" },
          { key: "failed", label: "失败", value: report.failed, tone: "danger" },
        ]}
        ariaLabel="整理执行结果构成"
      />
      {report.details.length > 0 && (
        <div className={`ai-chat-report-list${report.details.length > 6 ? " scrollable" : ""}`}>
          {report.details.map((detail) => (
            <article key={detail.fileId} className={`ai-chat-report-row report-${detail.status}`}>
              <Icon name={reportIcon(detail)} size={14} />
              <div>
                <strong title={detail.currentName}>{detail.currentName}</strong>
                <span>{detail.detail}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
