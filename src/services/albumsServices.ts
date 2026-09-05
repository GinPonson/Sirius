import { invoke } from "@tauri-apps/api/core";

export type AlbumPhoto = {
  fileId: string;
  folderId: string;
  pickCode: string;
  name: string;
  sizeBytes: number;
  takenAt: number;
  thumbUrl: string | null;
};
export type AlbumMonthGroup = {
  monthKey: string;
  photoCount: number;
  photos: AlbumPhoto[];
};
export type AlbumGroup = {
  folderId: string;
  folderName: string;
  photoCount: number;
  coverUrl: string | null;
};
export type PhotosOverview = {
  folderId: string;
  folderName: string;
  scannedCount: number;
  truncated: boolean;
  months: AlbumMonthGroup[];
  skippedCount: number;
};
export type AlbumsIndexSummary = {
  folderCount: number;
  lastScannedAt: string;
  photoCount: number;
  months: AlbumMonthGroup[];
  albums: AlbumGroup[];
};
export type AlbumFolderInput = { folderId: string; folderName: string };

/** 相册模式应用服务；索引只存在于本机 SQLite，识别为只读手动操作。 */
export class AlbumsService {
  recognize(input: AlbumFolderInput): Promise<PhotosOverview> {
    return invoke("albums_recognize", { input });
  }

  /** 读取本机持久化索引：统一时间线 + 按目录分组的专辑。 */
  index(): Promise<AlbumsIndexSummary> {
    return invoke("albums_index");
  }

  /** 批量索引多个目录；Rust 侧单次上限 20 个，顺序执行并各自持久化。 */
  indexFolders(folders: AlbumFolderInput[]): Promise<PhotosOverview[]> {
    return invoke("albums_index_folders", { folders });
  }

  /** 仅从本机移除一个目录的索引；远程目录与照片不受影响。 */
  removeIndex(folderId: string): Promise<void> {
    return invoke("albums_remove_index", { folderId });
  }
}
