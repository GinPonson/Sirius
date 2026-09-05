use std::{
    collections::{BTreeMap, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

const BUNDLED_LIBRARY_DIRECTORY: &str = "target/macos-libs";

fn main() {
    configure_macos_libmpv();
    tauri_build::build()
}

/// 为 macOS 收集 libmpv 及其 Homebrew 动态依赖，并统一改写为 App 内相对路径。
///
/// 构建产物放在 `target/macos-libs`，随后由 Tauri 复制到
/// `Sirius.app/Contents/Frameworks`。系统框架和 `/usr/lib` 由 macOS 提供，不复制。
fn configure_macos_libmpv() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    println!("cargo:rerun-if-env-changed=MPV_LIB_DIR");
    let default_path = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "/opt/homebrew/opt/mpv/lib",
        Ok("x86_64") => "/usr/local/opt/mpv/lib",
        Ok(architecture) => {
            panic!("Sirius 尚未定义 {architecture} 架构的 macOS libmpv 搜索路径")
        }
        Err(error) => panic!("无法读取目标架构：{error}"),
    };
    let library_directory =
        PathBuf::from(env::var("MPV_LIB_DIR").unwrap_or_else(|_| default_path.into()));
    let libmpv_path = library_directory.join("libmpv.dylib");
    if !libmpv_path.is_file() {
        panic!(
            "未在 {} 找到 libmpv.dylib；请安装 Homebrew mpv 或设置 MPV_LIB_DIR",
            library_directory.display()
        );
    }

    let manifest_directory = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR")
            .unwrap_or_else(|error| panic!("Cargo 未提供 CARGO_MANIFEST_DIR：{error}")),
    );
    let bundle_directory = manifest_directory.join(BUNDLED_LIBRARY_DIRECTORY);
    bundle_dynamic_libraries(&libmpv_path, &bundle_directory)
        .unwrap_or_else(|error| panic!("准备 macOS libmpv 动态库失败：{error}"));

    // libmpv2-sys 使用 `-lmpv`，因此链接搜索目录必须包含未版本化别名。
    println!(
        "cargo:rustc-link-search=native={}",
        bundle_directory.display()
    );
    // App 从 Contents/Frameworks 加载；后两项让 target/debug 与测试二进制也能
    // 通过相对路径访问同一份构建依赖，不把开发机绝对路径写进 Mach-O。
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../macos-libs");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../../macos-libs");
}

#[derive(Debug)]
struct BundledLibrary {
    source: PathBuf,
    file_name: String,
    dependencies: Vec<(String, PathBuf)>,
}

/// 从根动态库开始递归遍历 `otool -L`，复制并改写所有非系统依赖。
fn bundle_dynamic_libraries(root: &Path, destination: &Path) -> Result<(), String> {
    recreate_bundle_directory(destination)?;
    let root = canonicalize_library(root)?;
    let mut queue = VecDeque::from([root.clone()]);
    let mut libraries = BTreeMap::<PathBuf, BundledLibrary>::new();
    let mut names = BTreeMap::<String, PathBuf>::new();

    while let Some(source) = queue.pop_front() {
        if libraries.contains_key(&source) {
            continue;
        }
        println!("cargo:rerun-if-changed={}", source.display());
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("动态库名称无效：{}", source.display()))?
            .to_string();
        if let Some(previous) = names.insert(file_name.clone(), source.clone()) {
            if previous != source {
                return Err(format!(
                    "动态库名称冲突：{} 与 {} 都映射为 {file_name}",
                    previous.display(),
                    source.display()
                ));
            }
        }

        let dependencies = dynamic_dependencies(&source)?
            .into_iter()
            .filter_map(
                |install_name| match resolve_bundle_dependency(&source, &install_name) {
                    Ok(Some(dependency)) if dependency != source => {
                        queue.push_back(dependency.clone());
                        Some(Ok((install_name, dependency)))
                    }
                    Ok(_) => None,
                    Err(error) => Some(Err(error)),
                },
            )
            .collect::<Result<Vec<_>, _>>()?;
        libraries.insert(
            source.clone(),
            BundledLibrary {
                source,
                file_name,
                dependencies,
            },
        );
    }

    for library in libraries.values() {
        fs::copy(&library.source, destination.join(&library.file_name))
            .map_err(|error| format!("复制动态库 {} 失败：{error}", library.source.display()))?;
    }
    for library in libraries.values() {
        patch_install_names(library, destination, &libraries)?;
    }
    for library in libraries.values() {
        // install_name_tool 会使 Homebrew dylib 的原签名失效。先为构建缓存写入
        // 有效的 ad-hoc 签名，避免 cargo test/debug 在加载阶段被 macOS 直接终止；
        // 正式打包时 Tauri 会再按配置的 Developer ID 对嵌套代码统一签名。
        sign_bundled_library(&destination.join(&library.file_name))?;
    }

    // 链接阶段需要 libmpv.dylib；App 运行时仍按版本化 install name 加载真实文件。
    let root_name = libraries
        .get(&root)
        .map(|library| library.file_name.as_str())
        .ok_or_else(|| "libmpv 根动态库未进入打包集合".to_string())?;
    let alias = destination.join("libmpv.dylib");
    if alias.file_name().and_then(|value| value.to_str()) != Some(root_name) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(root_name, &alias)
            .map_err(|error| format!("创建 libmpv 链接别名失败：{error}"))?;
    }
    Ok(())
}

fn recreate_bundle_directory(destination: &Path) -> Result<(), String> {
    if destination.ends_with(BUNDLED_LIBRARY_DIRECTORY) && destination.exists() {
        fs::remove_dir_all(destination)
            .map_err(|error| format!("清理旧动态库目录 {} 失败：{error}", destination.display()))?;
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("创建动态库打包目录 {} 失败：{error}", destination.display()))
}

/// 返回 `otool -L` 中的原始 install name，后续必须按原值执行 `-change`。
fn dynamic_dependencies(library: &Path) -> Result<Vec<String>, String> {
    let output = Command::new("otool")
        .arg("-L")
        .arg(library)
        .output()
        .map_err(|error| format!("执行 otool 失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "otool 无法读取 {}：{}",
            library.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("otool 输出不是 UTF-8：{error}"))?;
    Ok(stdout
        .lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next())
        .map(str::to_string)
        .collect())
}

/// 解析需要随 App 分发的依赖；系统库明确返回 `None`。
fn resolve_bundle_dependency(owner: &Path, install_name: &str) -> Result<Option<PathBuf>, String> {
    if install_name.starts_with("/System/Library/") || install_name.starts_with("/usr/lib/") {
        return Ok(None);
    }
    let candidate = if let Some(relative) = install_name.strip_prefix("@loader_path/") {
        owner
            .parent()
            .ok_or_else(|| format!("动态库缺少父目录：{}", owner.display()))?
            .join(relative)
    } else if let Some(relative) = install_name.strip_prefix("@rpath/") {
        owner
            .parent()
            .ok_or_else(|| format!("动态库缺少父目录：{}", owner.display()))?
            .join(relative)
    } else if install_name.starts_with('/') {
        PathBuf::from(install_name)
    } else {
        return Err(format!(
            "{} 包含无法解析的动态库引用：{install_name}",
            owner.display()
        ));
    };
    canonicalize_library(&candidate).map(Some)
}

fn canonicalize_library(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("解析动态库 {} 失败：{error}", path.display()))
}

fn patch_install_names(
    library: &BundledLibrary,
    destination: &Path,
    libraries: &BTreeMap<PathBuf, BundledLibrary>,
) -> Result<(), String> {
    let bundled_path = destination.join(&library.file_name);
    run_install_name_tool(&[
        "-id".to_string(),
        format!("@rpath/{}", library.file_name),
        bundled_path.to_string_lossy().into_owned(),
    ])?;
    for (original_name, dependency) in &library.dependencies {
        let dependency_name = libraries
            .get(dependency)
            .map(|value| value.file_name.as_str())
            .ok_or_else(|| {
                format!(
                    "{} 的依赖 {} 未进入打包集合",
                    library.source.display(),
                    dependency.display()
                )
            })?;
        run_install_name_tool(&[
            "-change".to_string(),
            original_name.clone(),
            format!("@rpath/{dependency_name}"),
            bundled_path.to_string_lossy().into_owned(),
        ])?;
    }
    Ok(())
}

fn run_install_name_tool(arguments: &[String]) -> Result<(), String> {
    let output = Command::new("install_name_tool")
        .args(arguments)
        .output()
        .map_err(|error| format!("执行 install_name_tool 失败：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "install_name_tool 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// 为改写后的单个 Mach-O 动态库生成 ad-hoc 签名。
fn sign_bundled_library(library: &Path) -> Result<(), String> {
    let output = Command::new("codesign")
        .args(["--force", "--sign", "-", "--timestamp=none"])
        .arg(library)
        .output()
        .map_err(|error| format!("执行 codesign 失败：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "codesign 无法签名 {}：{}",
            library.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
