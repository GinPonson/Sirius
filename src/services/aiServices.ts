import { invoke } from "@tauri-apps/api/core";

export type AiProviderSettingsView = { baseUrl: string; model: string; keyStored: boolean };
export type AiProviderUpdateInput = { baseUrl: string; model: string; apiKey: string | null };
export type AiPlanAction = "keep" | "rename" | "move" | "delete";
export type AiPlanItem = {
  fileId: string;
  currentName: string;
  action: AiPlanAction;
  suggestedName: string;
  targetFolder: string;
  reason: string;
};
export type AiOrganizationPlan = {
  folderId: string;
  analyzedCount: number;
  truncated: boolean;
  summary: string;
  model: string;
  items: AiPlanItem[];
};
export type AiExecutionItemInput = {
  fileId: string;
  currentName: string;
  action: AiPlanAction;
  suggestedName: string;
  targetFolder: string;
};
export type AiExecutionRequestInput = {
  folderId: string;
  confirmed: boolean;
  items: AiExecutionItemInput[];
};
export type AiExecutionDetail = {
  fileId: string;
  currentName: string;
  action: AiPlanAction;
  status: string;
  detail: string;
};
export type AiExecutionReport = {
  executed: number;
  skipped: number;
  failed: number;
  deletedToRecycleBin: number;
  createdFolders: number;
  details: AiExecutionDetail[];
};

/** AI 整理应用服务；API 密钥只经过 Rust 落到钥匙串，前端不留存。 */
export class AiOrganizationService {
  settings(): Promise<AiProviderSettingsView> {
    return invoke("ai_provider_settings");
  }

  updateProvider(settings: AiProviderUpdateInput): Promise<AiProviderSettingsView> {
    return invoke("ai_update_provider", { settings });
  }

  /** 只读分析：返回的计划只是建议数据，执行将在确认步骤中另行实现。 */
  analyzeFolder(folderId: string): Promise<AiOrganizationPlan> {
    return invoke("ai_analyze_folder", { folderId });
  }

  /** 执行用户已确认的计划；Rust 策略引擎重新校验快照绑定并强制执行重命名/移动/删除策略。 */
  executePlan(request: AiExecutionRequestInput): Promise<AiExecutionReport> {
    return invoke("ai_execute_plan", { request });
  }
}
