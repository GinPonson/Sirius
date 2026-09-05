// 生成 SPDX 2.3 SBOM 与人读许可证清单。
// 用法：node scripts/generate-sbom.mjs
// 数据来源：src-tauri/Cargo.lock + cargo registry 源码清单、package.json + node_modules。
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const registryRoots = readdirSync(join(process.env.HOME, ".cargo/registry/src")).map(
  (dir) => join(process.env.HOME, ".cargo/registry/src", dir),
);
const cacheRoots = readdirSync(join(process.env.HOME, ".cargo/registry/cache")).map(
  (dir) => join(process.env.HOME, ".cargo/registry/cache", dir),
);

function localCargoLicense(name, version) {
  // 工作区根项目不在 registry 中，直接读取 src-tauri/Cargo.toml。
  if (name === "sirius-desktop") {
    const text = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
    return text.match(/^\s*license\s*=\s*"([^"]+)"/m)?.[1] ?? "NOASSERTION";
  }
  for (const registry of registryRoots) {
    const manifest = join(registry, `${name}-${version}`, "Cargo.toml");
    if (!existsSync(manifest)) continue;
    const text = readFileSync(manifest, "utf8");
    const match = text.match(/^\s*license\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
    const file = text.match(/^\s*license-file\s*=\s*"([^"]+)"/m);
    if (file) return `LICENSE-FILE(${file[1]})`;
    return "NOASSERTION";
  }
  // 未解包的 .crate 缓存：直接从 tarball 读取清单，避免平台依赖出现 NOASSERTION。
  for (const cache of cacheRoots) {
    const cratePath = join(cache, `${name}-${version}.crate`);
    if (!existsSync(cratePath)) continue;
    try {
      const text = execFileSync(
        "tar",
        ["-xzOf", cratePath, `${name}-${version}/Cargo.toml`],
        { maxBuffer: 8 * 1024 * 1024 },
      ).toString("utf8");
      const match = text.match(/^\s*license\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
      const file = text.match(/^\s*license-file\s*=\s*"([^"]+)"/m);
      if (file) return `LICENSE-FILE(${file[1]})`;
      return "NOASSERTION";
    } catch {
      return "NOASSERTION";
    }
  }
  return "NOASSERTION";
}

async function cratesIoLicense(name, version) {
  try {
    const response = await fetch(`https://crates.io/api/v1/crates/${name}/${version}`, {
      headers: { "User-Agent": "sirius-sbom-generator (local build script)" },
    });
    if (!response.ok) return "NOASSERTION";
    const payload = await response.json();
    return payload.version?.license ?? "NOASSERTION";
  } catch {
    return "NOASSERTION";
  }
}

async function resolveRustLicenses(packages) {
  const resolved = [];
  let fetched = 0;
  for (const item of packages) {
    if (item.license === "NOASSERTION") {
      item.license = await cratesIoLicense(item.name, item.version);
      fetched += 1;
    }
    resolved.push(item);
  }
  if (fetched > 0) console.log(`从 crates.io 补齐 ${fetched} 个许可证`);
  return resolved;
}

function parseCargoLock() {
  const text = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  const packages = [];
  for (const block of text.split("[[package]]").slice(1)) {
    const name = block.match(/^name = "(.+)"$/m)?.[1];
    const version = block.match(/^version = "(.+)"$/m)?.[1];
    if (name && version) packages.push({ name, version });
  }
  return packages;
}

function npmLicense(name) {
  const manifest = join(root, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return "NOASSERTION";
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  return pkg.license ?? "NOASSERTION";
}

function npmDependencies() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const resolved = [];
  for (const name of names) {
    const manifest = join(root, "node_modules", name, "package.json");
    if (!existsSync(manifest)) continue;
    const info = JSON.parse(readFileSync(manifest, "utf8"));
    resolved.push({ name, version: info.version });
  }
  return resolved;
}

const rustPackages = parseCargoLock().map(({ name, version }) => ({
  name,
  version,
  license: localCargoLicense(name, version),
  origin: "Cargo (src-tauri)",
}));
const npmPackages = npmDependencies().map(({ name, version }) => ({
  name,
  version,
  license: npmLicense(name),
  origin: "npm (frontend)",
}));
const resolvedRust = await resolveRustLicenses(rustPackages);
const all = [...resolvedRust, ...npmPackages];
const generatedAt = new Date().toISOString();

const spdx = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "Sirius-Desktop",
  documentNamespace: `https://sirius.local/sbom/sirius-desktop-${generatedAt}`,
  creationInfo: {
    created: generatedAt,
    creators: ["Tool: Sirius scripts/generate-sbom.mjs"],
  },
  packages: all.map((item, index) => ({
    SPDXID: `SPDXRef-Package-${index}`,
    name: item.name,
    versionInfo: item.version,
    licenseConcluded: item.license,
    filesAnalyzed: false,
    supplier: "NOASSERTION",
  })),
};

const licenses = all
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((item) => `| ${item.name} | ${item.version} | ${item.license} | ${item.origin} |`);

const markdown = `# Sirius 第三方依赖许可证清单

由 \`scripts/generate-sbom.mjs\` 生成于 ${generatedAt}；机读版本见 \`docs/sbom.spdx.json\`（SPDX 2.3）。

| 包 | 版本 | 许可证 (SPDX) | 来源 |
| --- | --- | --- | --- |
${licenses.join("\n")}

共 ${all.length} 个依赖。NOASSERTION 表示上游清单未声明 SPDX 许可证，发布前需人工复核。
`;

writeFileSync(join(root, "docs/sbom.spdx.json"), `${JSON.stringify(spdx, null, 2)}\n`);
writeFileSync(join(root, "docs/licenses.md"), markdown);
console.log(`SBOM 已生成：${all.length} 个依赖（Rust ${rustPackages.length}，npm ${npmPackages.length}）`);

// ===== 第三方许可材料（随包分发）=====
import { writeFileSync as writeText } from "node:fs";

function licenseTerms(expression) {
  return expression
    .split(/\s+(?:OR|AND|WITH)\s+|\//)
    .map((term) => term.trim().replace(/^[()]+|[()]+$/g, "").trim())
    .filter((term) => term && term !== "NOASSERTION" && !term.startsWith("License"));
}

const CACHE_PATH = new URL("./.spdx-texts.json", import.meta.url).pathname;
const spdxCache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};

async function spdxText(id) {
  if (spdxCache[id]) return spdxCache[id];
  try {
    const response = await fetch(`https://spdx.org/licenses/${id}.json`, {
      headers: { "User-Agent": "sirius-sbom-generator (local build script)" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload.licenseText ?? payload.licenseExceptionText ?? null;
    if (text) spdxCache[id] = text;
    return text;
  } catch {
    return null;
  }
}

const terms = new Set();
for (const item of all) {
  for (const term of licenseTerms(item.license)) terms.add(term);
}

const texts = {};
for (const id of [...terms].sort()) {
  const text = await spdxText(id);
  if (text) texts[id] = text;
  else console.log(`警告：无法获取 ${id} 许可证全文，请人工补充`);
}
writeFileSync(CACHE_PATH, JSON.stringify(spdxCache, null, 2));

const sections = [...Object.keys(texts)].sort().map((id) => `### ${id}\n\n\`\`\`\n${texts[id].trim()}\n\`\`\`\n`);
const material = `# 第三方许可材料（Third-Party Licenses）

本应用包含以下 ${all.length} 个第三方依赖，各依赖按其上游声明的许可证分发；
下方列出涉及的许可证全文与逐包对照。生成于 ${generatedAt}。

## 涉及的许可证（${Object.keys(texts).length} 种）

${Object.keys(texts).sort().join("、")}

${sections.join("\n")}

## 逐包许可对照

| 包 | 版本 | 许可证 (SPDX) |
| --- | --- | --- |
${all
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((item) => `| ${item.name} | ${item.version} | ${item.license} |`)
  .join("\n")}
`;
writeText(new URL("../src-tauri/THIRD-PARTY-LICENSES.md", import.meta.url).pathname, material);
console.log(`第三方许可材料已生成：${Object.keys(texts).length} 种许可证全文`);
