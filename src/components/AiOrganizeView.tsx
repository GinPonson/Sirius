import { useEffect, useState } from "react";
import {
  AiOrganizationService,
  type AiExecutionReport,
  type AiOrganizationPlan,
  type AiPlanItem,
  type AiProviderSettingsView,
} from "../services/aiServices";
import { Cloud115Service, type Cloud115FileEntry } from "../services/mediaServices";
import { Icon } from "./Icon";

const aiService = new AiOrganizationService();
const cloud115 = new Cloud115Service();

const ROOT_ID = "0";

function actionIcon(action: AiPlanItem["action"]) {
  if (action === "rename") return "edit";
  if (action === "move") return "folder";
  if (action === "delete") return "trash";
  return "check";
}

function actionLabel(
  item: Pick<AiPlanItem, "action"> & Partial<Pick<AiPlanItem, "suggestedName" | "targetFolder">>,
) {
  if (item.action === "rename") return <span>重命名为 <em>{item.suggestedName || "—"}</em></span>;
  if (item.action === "move") return <span>移动到 <em>{item.targetFolder || "—"}</em></span>;
  if (item.action === "delete") return <span>移入回收站</span>;
  return <span>保持现状</span>;
}

/** AI 整理工作台：只读分析 → 计划预览 → 显式确认 → Rust 策略执行 → 结果报告。 */
export function AiOrganizeView() {
  const [settings, setSettings] = useState<AiProviderSettingsView | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [rootFolders, setRootFolders] = useState<Cloud115FileEntry[]>([]);
  const [folderId, setFolderId] = useState(ROOT_ID);
  const [analyzing, setAnalyzing] = useState(false);
  const [plan, setPlan] = useState<AiOrganizationPlan | null>(null);
  // 用户逐项勾选要执行的建议；删除项默认不勾选，必须显式选择。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [report, setReport] = useState<AiExecutionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    aiService.settings()
      .then((view) => {
        if (!active) return;
        setSettings(view);
        setBaseUrl(view.baseUrl);
        setModel(view.model);
      })
      .catch((reason) => active && setError(`读取 AI 配置失败：${String(reason)}`));
    cloud115.listFiles(ROOT_ID, "", 0, 100)
      .then((page) => {
        if (active) setRootFolders(page.entries.filter((entry) => entry.kind === "folder"));
      })
      .catch((reason) => active && setError(`读取网盘目录失败：${String(reason)}`));
    return () => {
      active = false;
    };
  }, []);

  async function saveProvider() {
    setSavingSettings(true);
    setError(null);
    try {
      const next = await aiService.updateProvider({
        baseUrl,
        model,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
      });
      setSettings(next);
      setApiKey("");
      setNotice("AI 配置已保存");
    } catch (reason) {
      setError(`保存 AI 配置失败：${String(reason)}`);
    } finally {
      setSavingSettings(false);
    }
  }

  async function runAnalysis() {
    setAnalyzing(true);
    setError(null);
    try {
      const next = await aiService.analyzeFolder(folderId);
      setPlan(next);
      setReport(null);
      // 重命名与移动默认勾选；删除必须由用户显式勾选。
      setSelected(new Set(
        next.items
          .filter((item) => item.action === "rename" || item.action === "move")
          .map((item) => item.fileId),
      ));
    } catch (reason) {
      setError(`AI 分析失败：${String(reason)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  function toggleSelected(fileId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }

  async function executeSelected() {
    if (!plan) return;
    setExecuting(true);
    setError(null);
    try {
      const result = await aiService.executePlan({
        folderId: plan.folderId,
        confirmed: true,
        items: plan.items
          .filter((item) => selected.has(item.fileId))
          .map((item) => ({
            fileId: item.fileId,
            currentName: item.currentName,
            action: item.action,
            suggestedName: item.suggestedName,
            targetFolder: item.targetFolder,
          })),
      });
      setReport(result);
      setShowConfirm(false);
      setNotice(null);
    } catch (reason) {
      setError(`执行整理计划失败：${String(reason)}`);
    } finally {
      setExecuting(false);
    }
  }

  const selectedItems = plan?.items.filter((item) => selected.has(item.fileId)) ?? [];
  const deleteCount = selectedItems.filter((item) => item.action === "delete").length;
  const hasExecutableItems = plan?.items.some((item) => item.action !== "keep") ?? false;

  return (
    <section className="page-section narrow-section ai-organize-view">
      <p className="ai-privacy-note">
        分析只读取文件名等基础信息并发送给所配置的模型；修改只有在计划预览中逐项确认后才会执行，
        删除会进入 115 回收站，API 密钥只保存在 macOS 钥匙串。
      </p>

      {error && <div className="cloud-inline-error" role="alert">{error}</div>}

      {notice && <div className="cloud-action-notice" role="status"><Icon name="check" size={14} />{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button></div>}

      <div className="settings-group">
        <h2>模型服务</h2>
        <div className="setting-row">
          <div>
            <strong>服务商地址</strong>
            <p>OpenAI 兼容接口，例如 https://api.deepseek.com</p>
          </div>
          <input
            className="ai-text-input"
            value={baseUrl}
            placeholder="https://api.deepseek.com"
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>模型</strong>
            <p>用于文件名分析与整理建议</p>
          </div>
          <input
            className="ai-text-input"
            value={model}
            placeholder="deepseek-chat"
            onChange={(event) => setModel(event.currentTarget.value)}
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>API 密钥</strong>
            <p>{settings?.keyStored ? "已保存在 macOS 钥匙串" : "尚未保存密钥"}</p>
          </div>
          <input
            className="ai-text-input"
            type="password"
            value={apiKey}
            placeholder={settings?.keyStored ? "留空保持现有密钥" : "sk-…"}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>保存配置</strong>
            <p>密钥保存后不会再次显示</p>
          </div>
          <button className="primary-action" disabled={savingSettings} onClick={() => void saveProvider()}>
            {savingSettings ? "正在保存…" : "保存"}
          </button>
        </div>
      </div>

      <div className="settings-group">
        <h2>分析范围</h2>
        <div className="setting-row">
          <div>
            <strong>目标目录</strong>
            <p>最多读取前 200 项参与分析</p>
          </div>
          <select
            value={folderId}
            aria-label="选择分析目录"
            onChange={(event) => setFolderId(event.currentTarget.value)}
          >
            <option value={ROOT_ID}>网盘根目录</option>
            {rootFolders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>生成整理计划</strong>
            <p>只读取目录并给出建议，不会修改文件</p>
          </div>
          <button className="primary-action" disabled={analyzing} onClick={() => void runAnalysis()}>
            <Icon name="sparkles" size={15} />
            {analyzing ? "正在分析…" : "生成整理计划"}
          </button>
        </div>
      </div>

      {plan && (
        <div className="settings-group ai-plan-group">
          <h2>整理计划预览</h2>
          <p className="ai-plan-summary">
            {plan.summary || "模型未提供总结"}
            {plan.truncated ? " · 目录较大，仅分析前 200 项" : ""} · {plan.analyzedCount} 项 · 模型 {plan.model}
          </p>
          {plan.items.length === 0 ? (
            <div className="ai-plan-empty">该目录已足够规范，模型没有提出调整建议。</div>
          ) : (
            <div className="ai-plan-list">
              {plan.items.map((item) => {
                const executable = item.action !== "keep";
                return (
                  <article
                    key={item.fileId}
                    className={`ai-plan-item ${item.action}${executable && selected.has(item.fileId) ? " selected" : ""}`}
                  >
                    <div className="ai-plan-file">
                      {executable && (
                        <input
                          type="checkbox"
                          className="file-check"
                          aria-label={`选择执行 ${item.currentName}`}
                          checked={selected.has(item.fileId)}
                          disabled={executing}
                          onChange={() => toggleSelected(item.fileId)}
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
          {hasExecutableItems && (
            <div className="ai-plan-footer">
              <span>
                已选 {selected.size} 项{deleteCount > 0 ? `，其中 ${deleteCount} 项删除将进入回收站` : ""}
              </span>
              <button
                className="danger-action"
                disabled={selected.size === 0 || executing}
                onClick={() => setShowConfirm(true)}
              >
                {executing ? "正在执行…" : "执行所选项"}
              </button>
            </div>
          )}
        </div>
      )}

      {report && (
        <div className="settings-group ai-report-group">
          <h2>执行报告</h2>
          <p className="ai-plan-summary">
            已执行 {report.executed} · 跳过 {report.skipped} · 失败 {report.failed}
            {report.deletedToRecycleBin > 0 ? ` · ${report.deletedToRecycleBin} 项移入回收站` : ""}
            {report.createdFolders > 0 ? ` · 新建 ${report.createdFolders} 个文件夹` : ""}
          </p>
          {report.details.length > 0 && (
            <div className="ai-plan-list">
              {report.details.map((detail) => (
                <article key={detail.fileId} className={`ai-plan-item report-${detail.status}`}>
                  <div className="ai-plan-file">
                    <Icon
                      name={detail.status === "done" ? "check" : detail.status === "failed" ? "alert" : "history"}
                      size={16}
                    />
                    <strong>{detail.currentName}</strong>
                  </div>
                  <div className="ai-plan-change">{actionLabel(detail)}</div>
                  <p>{detail.detail}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {showConfirm && (
        <div
          className="cloud-operation-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && !executing && setShowConfirm(false)}
        >
          <section className="cloud-operation-dialog" role="dialog" aria-modal="true" aria-label="确认执行整理计划">
            <strong>确认执行整理计划？</strong>
            <span>
              将对 {selected.size} 个文件执行修改并立即生效：重命名与移动直接应用，
              {deleteCount > 0 ? `${deleteCount} 项删除会移入 115 回收站（可还原）` : "删除项会移入 115 回收站（可还原）"}。
              执行前系统会重新核对每个文件的当前状态。
            </span>
            <div>
              <button className="secondary-action" disabled={executing} onClick={() => setShowConfirm(false)}>取消</button>
              <button className="danger-action" disabled={executing} onClick={() => void executeSelected()}>
                {executing ? "正在执行…" : "确认执行"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
