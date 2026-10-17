import type { Cloud115FileEntry } from "../services/mediaServices";

/**
 * 网盘文件查重的纯算法层：只做「分组 / 默认保留 / 默认勾选 / 校验」的判断，
 * 不发起任何 Tauri 调用、不读写 React 状态，便于逐条复核与后续补测试。
 *
 * 判定规则对齐 StarVault 已验证实现（`ui/files/DuplicateFiles.kt`）：
 * 1. 文件名完全相同；
 * 2. SHA1（大写归一）+ 文件大小相同，SHA1 为空的条目只能命中规则 1。
 * 两条规则用并查集**传递合并**：A 与 B 同名、B 与 C 内容相同时，A/B/C 归入同一组。
 */

/** 重复判定原因；同组可以同时命中两种规则。 */
export type DuplicateReason = "name" | "content" | "both";

/** 一组通过「文件名」或「SHA1 + 大小」传递合并起来的重复文件。 */
export type DuplicateGroup = {
  /** 组稳定标识：取组内首项（输入顺序）的文件 ID，用作 React key 与默认保留定位。 */
  id: string;
  /** 组内成员，保持输入顺序，至少 2 项。 */
  entries: Cloud115FileEntry[];
  /** 该组实际命中的判定原因。 */
  reason: DuplicateReason;
};

/** 查重扫描单页条数：与 Rust `cloud115.rs` 的 `MAX_PAGE_LIMIT` 一致，大页可把整目录压到常数级请求。 */
export const DUPLICATE_SCAN_PAGE_LIMIT = 1150;

/** 单次查重扫描允许的目录条目上限；超过即明确拒绝，不做无界扫描。 */
export const DUPLICATE_SCAN_MAX_ENTRIES = 20_000;

/** 单批删除条数：100 项一批，限制请求体并给出稳定的进度粒度。 */
export const DUPLICATE_DELETE_BATCH_SIZE = 100;

/**
 * 副本名标记：`(1)` / `（1）` / `- 副本` / `_副本` / ` 副本` / `copy` 结尾。
 *
 * 与 StarVault 一致地作用于「去掉扩展名的主名」——`照片 (1).jpg` 的标记在主名末尾，
 * 直接匹配完整文件名会因为扩展名而以 `$` 失配。
 */
const COPY_MARKER_AT_END = /(?:\(\d+\)|（\d+）|[-_\s]*副本|[-_\s]*copy)\s*$/i;

/**
 * 判断文件名主名（去扩展名）是否带副本标记。
 *
 * @param name 文件完整名称，如 `照片 (1).jpg`。
 * @returns 主名以副本标记结尾时为 true。
 */
export function hasCopyMarker(name: string): boolean {
  const dot = name.lastIndexOf(".");
  // 与 Kotlin `substringBeforeLast('.')` 对齐：无扩展名时用整个名称；隐藏文件（.gitignore）保留原名。
  const mainName = dot > 0 ? name.slice(0, dot) : name;
  return COPY_MARKER_AT_END.test(mainName);
}

/**
 * 内容指纹键：SHA1 大写归一 + 文件大小；SHA1 为空（服务端未提供）时返回 null，
 * 使该条目不参与内容查重，避免缺失指纹的文件被错误合并。
 *
 * @param entry 115 文件条目。
 * @returns 可用于内容比对的键，或 null 表示不参与。
 */
function contentKeyOf(entry: Cloud115FileEntry): string | null {
  const sha1 = entry.sha1.trim().toUpperCase();
  return sha1 === "" ? null : `${sha1}:${entry.sizeBytes}`;
}

/**
 * 计算一组已被并查集合并的文件的判定原因。
 *
 * 按组内「是否有两个成员同名」「是否有两个成员内容相同」分别判定，而不是回溯合并边：
 * 若 A、B 同名且内容也相同时，第二次内容合并是空操作（两者已在同一集合），
 * 只回溯合并边会把 `both` 误报成 `name`。
 *
 * @param entries 同一重复组内的文件（至少 2 项）。
 * @returns `"both"` 表示同名且内容重复；否则返回唯一可能命中的规则——
 *   组只能由「同名」或「同内容」合并产生，两者皆无的组不存在（单成员组已在上层过滤）。
 */
function describeReason(entries: Cloud115FileEntry[]): DuplicateReason {
  const nameCounts = new Map<string, number>();
  const contentCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
    const contentKey = contentKeyOf(entry);
    if (contentKey !== null) {
      contentCounts.set(contentKey, (contentCounts.get(contentKey) ?? 0) + 1);
    }
  }
  const hasDuplicateName = [...nameCounts.values()].some((count) => count > 1);
  const hasDuplicateContent = [...contentCounts.values()].some((count) => count > 1);
  if (hasDuplicateName && hasDuplicateContent) return "both";
  return hasDuplicateName ? "name" : "content";
}

/**
 * 按「文件名相同」或「SHA1 + 文件大小相同」合并重复文件。
 *
 * 文件夹不参与查重（`kind === "folder"` 会被跳过），因为目录无法按内容判定；
 * 组内与组间顺序都保持输入顺序，结果可直接渲染。
 *
 * @param entries 当前目录内的文件条目（可含文件夹，函数内部会过滤）。
 * @returns 至少包含两个文件的重复组；无重复时返回空数组。
 */
export function findDuplicateGroups(entries: Cloud115FileEntry[]): DuplicateGroup[] {
  const files = entries.filter((entry) => entry.kind !== "folder");
  if (files.length < 2) return [];

  // 并查集：parent[i] 指向父节点，根节点指向自身。
  const parent = files.map((_, index) => index);

  /** 取根节点并做路径减半，保持接近常数的查找开销。 */
  const rootOf = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };

  /** 合并两个下标所属集合；先出现的一侧作为新根，从而组顺序与组内顺序都跟随输入。 */
  const union = (first: number, second: number) => {
    const firstRoot = rootOf(first);
    const secondRoot = rootOf(second);
    if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot;
  };

  /** 按给定键合并：同一键只与首次出现的下标合并，即得到该键下的等价类。 */
  const mergeByKey = (keyOf: (entry: Cloud115FileEntry) => string | null) => {
    const firstIndexByKey = new Map<string, number>();
    files.forEach((entry, index) => {
      const key = keyOf(entry);
      if (key === null) return;
      const firstIndex = firstIndexByKey.get(key);
      if (firstIndex === undefined) {
        firstIndexByKey.set(key, index);
      } else {
        union(firstIndex, index);
      }
    });
  };

  mergeByKey((entry) => entry.name);
  mergeByKey(contentKeyOf);

  // 按根归组：Map 保持首次插入顺序，等价于 Kotlin `groupBy` 的 LinkedHashMap 语义。
  const indexesByRoot = new Map<number, number[]>();
  files.forEach((_, index) => {
    const groupRoot = rootOf(index);
    const bucket = indexesByRoot.get(groupRoot);
    if (bucket) {
      bucket.push(index);
    } else {
      indexesByRoot.set(groupRoot, [index]);
    }
  });

  return [...indexesByRoot.values()]
    .filter((indexes) => indexes.length > 1)
    .map((indexes) => {
      const groupEntries = indexes.map((index) => files[index]);
      return { id: groupEntries[0].id, entries: groupEntries, reason: describeReason(groupEntries) };
    });
}

/** 两项是否互为重复：同名，或 SHA1 + 大小一致（两边 SHA1 都必须非空）。 */
function isDuplicatePair(a: Cloud115FileEntry, b: Cloud115FileEntry): boolean {
  if (a.id === b.id) return false;
  if (a.name === b.name) return true;
  const contentA = contentKeyOf(a);
  const contentB = contentKeyOf(b);
  return contentA !== null && contentA === contentB;
}

/**
 * 组内默认保留项：优先「干净名字」（主名不带副本标记），仅当组内恰好只有一个干净名字时生效；
 * 否则保留修改时间最早的一项（时间缺失/为 0 的条目不参与竞争），整组都没有时间时保留首项。
 *
 * @param group 已完成合并的重复组。
 * @returns 默认保留的文件；空组返回 null。
 */
export function defaultRetainedEntry(group: DuplicateGroup): Cloud115FileEntry | null {
  if (group.entries.length === 0) return null;

  const cleanNamed = group.entries.filter((entry) => !hasCopyMarker(entry.name));
  if (cleanNamed.length === 1) return cleanNamed[0];

  let oldest: Cloud115FileEntry | null = null;
  for (const entry of group.entries) {
    if (!Number.isFinite(entry.modifiedAt) || entry.modifiedAt <= 0) continue;
    // 严格小于：并列最早时保留输入顺序中的第一项（对齐 Kotlin minByOrNull）。
    if (oldest === null || entry.modifiedAt < oldest.modifiedAt) oldest = entry;
  }
  return oldest ?? group.entries[0];
}

/**
 * 计算默认勾选删除的文件 ID。
 *
 * 勾选范围只覆盖**与保留项确实互为重复**的成员：分组是传递的（A 与 B 同名、B 与 C 同内容
 * → 同组），若简单按「除保留项外全勾掉」，会把与保留项毫无重复关系的另一份内容的副本也一并
 * 勾掉。这类成员仍显示在组内，但默认不勾，交由用户判断。
 *
 * @param groups 已完成合并的重复组。
 * @returns 默认应移入回收站的文件 ID 集合。
 */
export function defaultDuplicateSelectionIds(groups: DuplicateGroup[]): Set<string> {
  const selected = new Set<string>();
  for (const group of groups) {
    const retained = defaultRetainedEntry(group);
    if (retained === null) continue;
    for (const entry of group.entries) {
      if (isDuplicatePair(entry, retained)) selected.add(entry.id);
    }
  }
  return selected;
}

/**
 * 找出「整组都被勾选删除」的组，用于拒绝删光整组（至少保留 1 项）。
 *
 * @param groups 已完成合并的重复组。
 * @param selectedIds 当前勾选删除的文件 ID。
 * @returns 会被清空的组；为空表示当前选择合法。
 */
export function groupsFullySelected(
  groups: DuplicateGroup[],
  selectedIds: ReadonlySet<string>,
): DuplicateGroup[] {
  return groups.filter(
    (group) => group.entries.length > 0 && group.entries.every((entry) => selectedIds.has(entry.id)),
  );
}

/**
 * 移除已确认删除的条目并重新分组，避免失败重试时重复提交已删除的文件。
 *
 * @param groups 当前重复组。
 * @param deletedIds 服务端已确认移入回收站的 ID。
 * @returns 依据剩余条目重新计算的重复组。
 */
export function removeDeletedEntriesFromGroups(
  groups: DuplicateGroup[],
  deletedIds: ReadonlySet<string>,
): DuplicateGroup[] {
  if (deletedIds.size === 0) return groups;
  // 按 ID 去重：同一文件只会出现在一个组里，这里的判重仅抵御异常输入。
  const remaining = new Map<string, Cloud115FileEntry>();
  for (const group of groups) {
    for (const entry of group.entries) {
      if (!deletedIds.has(entry.id)) remaining.set(entry.id, entry);
    }
  }
  return findDuplicateGroups([...remaining.values()]);
}
