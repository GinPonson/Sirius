import { invoke } from "@tauri-apps/api/core";

export type ComicsVolume = {
  fileId: string;
  pickCode: string;
  name: string;
  sizeBytes: number;
  coverPath: string | null;
};
export type ComicsSeriesGroup = {
  title: string;
  volumeCount: number;
  totalBytes: number;
  volumes: ComicsVolume[];
};
export type ComicsOverview = {
  folderId: string;
  scannedCount: number;
  truncated: boolean;
  series: ComicsSeriesGroup[];
  looseImageCount: number;
  skippedCount: number;
};
export type ComicsIndexSummary = {
  folderCount: number;
  lastScannedAt: string;
  series: ComicsSeriesGroup[];
};
export type ComicOpenInput = {
  fileId: string;
  pickCode: string;
  fileName: string;
  seriesTitle: string;
  sizeBytes: number;
};
export type ComicSession = {
  fileId: string;
  seriesTitle: string;
  pages: string[];
  pageCount: number;
  resumePageIndex: number;
};

/** 漫画模式应用服务；索引、封面缓存与阅读进度只存在于本机。 */
export class ComicsService {
  recognize(folderId: string): Promise<ComicsOverview> {
    return invoke("comics_recognize", { folderId });
  }

  /** 读取本机持久化索引，合并为统一书架并补齐缓存封面路径。 */
  index(): Promise<ComicsIndexSummary> {
    return invoke("comics_index");
  }

  /** 批量索引多个目录；Rust 侧单次上限 20 个，顺序执行并各自持久化。 */
  indexFolders(folderIds: string[]): Promise<ComicsOverview[]> {
    return invoke("comics_index_folders", { folderIds });
  }

  /** 打开漫画卷：Rust 侧断点续传下载 + 解压 + 缓存预算淘汰，返回页图路径与续读页码。 */
  openVolume(input: ComicOpenInput): Promise<ComicSession> {
    return invoke("comics_open_volume", { input });
  }

  /** 保存阅读进度；翻页与关闭时调用，只写本机 SQLite。 */
  saveProgress(fileId: string, pageIndex: number, pageCount: number): Promise<void> {
    return invoke("comics_save_progress", { fileId, pageIndex, pageCount });
  }
}


