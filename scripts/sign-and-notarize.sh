#!/usr/bin/env bash
# 对 Sirius.app 执行固定的本机签名，或 Developer ID 分发签名与公证。
# 本机签名必须通过 SIGN_MODE=local 与 SHA-1 指纹显式启用；默认路径始终是分发签名。
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Sirius.app}"
SIGN_MODE="${SIGN_MODE:-distribution}"
ENTITLEMENTS="$(dirname "${BASH_SOURCE[0]}")/../src-tauri/entitlements.plist"
LOCAL_COMMON_NAME="Sirius Local Development"
LOCAL_BUNDLE_IDENTIFIER="com.sirius.desktop"
LOCAL_SIGNING_DIRECTORY="${HOME:-}/Library/Application Support/com.sirius.desktop/signing"
LOCAL_KEYCHAIN_PATH="${LOCAL_SIGNING_DIRECTORY}/sirius-local-signing.keychain-db"
LOCAL_KEYCHAIN_PASSWORD_FILE="${LOCAL_SIGNING_DIRECTORY}/keychain-password"
LOCAL_KEYCHAIN_LOCK_REQUIRED=0
LOCAL_SEARCH_ITEM_ADDED=0

# 按本次运行实际修改的状态清理 search list，再锁回专用钥匙串；保留既有失败码。
lock_local_keychain_on_exit() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT

  if [ "$LOCAL_SEARCH_ITEM_ADDED" -eq 1 ]; then
    if ! python3 - "$SIGN_KEYCHAIN" "$LOCAL_KEYCHAIN_PATH" <<'PY'
import shlex
import subprocess
import sys

keychain_path, expected_keychain_path = sys.argv[1:]
if keychain_path != expected_keychain_path:
    print("拒绝清理非固定的本机签名钥匙串。", file=sys.stderr)
    raise SystemExit(1)

try:
    current = subprocess.run(
        ["security", "list-keychains", "-d", "user"],
        capture_output=True,
        text=True,
        check=False,
    )
except OSError as error:
    print(f"无法读取当前用户钥匙串搜索列表：{error}", file=sys.stderr)
    raise SystemExit(1)
if current.returncode != 0:
    if current.stderr:
        sys.stderr.write(current.stderr)
    print("无法读取当前用户钥匙串搜索列表。", file=sys.stderr)
    raise SystemExit(1)

try:
    current_paths = shlex.split(current.stdout)
except ValueError as error:
    print(f"无法解析当前用户钥匙串搜索列表：{error}", file=sys.stderr)
    raise SystemExit(1)

# EXIT 清理时重读最新列表，只删除本脚本加入的路径，保留期间其他程序写入的项目。
remaining_paths = [path for path in current_paths if path != keychain_path]
if len(remaining_paths) == len(current_paths):
    raise SystemExit(0)
try:
    update = subprocess.run(
        ["security", "list-keychains", "-d", "user", "-s", *remaining_paths],
        capture_output=True,
        text=True,
        check=False,
    )
except OSError as error:
    print(f"无法更新当前用户钥匙串搜索列表：{error}", file=sys.stderr)
    raise SystemExit(1)
if update.returncode != 0:
    if update.stderr:
        sys.stderr.write(update.stderr)
    print("无法移除本次加入的专用钥匙串搜索项。", file=sys.stderr)
    raise SystemExit(1)
PY
    then
      echo "无法从当前用户钥匙串搜索列表移除本次加入的专用钥匙串。" >&2
      cleanup_status=1
    fi
  fi

  if [ "$LOCAL_KEYCHAIN_LOCK_REQUIRED" -eq 1 ]; then
    if ! security lock-keychain "$SIGN_KEYCHAIN"; then
      echo "无法重新锁定本机专用签名钥匙串：$SIGN_KEYCHAIN" >&2
      cleanup_status=1
    fi
  fi

  if [ "$original_status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
    original_status=1
  fi
  exit "$original_status"
}

case "$SIGN_MODE" in
  local)
    SIGN_IDENTITY="${SIGN_IDENTITY:-}"
    if [[ ! "$SIGN_IDENTITY" =~ ^[[:xdigit:]]{40}$ ]]; then
      echo "本机签名必须提供固定证书的 40 位 SHA-1 指纹；请执行 scripts/sign-local.sh。" >&2
      exit 1
    fi
    SIGN_IDENTITY="$(printf '%s' "$SIGN_IDENTITY" | tr '[:lower:]' '[:upper:]')"
    SIGN_KEYCHAIN="${SIGN_KEYCHAIN:-}"
    if [ "$SIGN_KEYCHAIN" != "$LOCAL_KEYCHAIN_PATH" ]; then
      echo "本机签名必须使用固定专用钥匙串：$LOCAL_KEYCHAIN_PATH" >&2
      exit 1
    fi

    # 自签名证书没有 Developer ID Team ID，libmpv 不能使用 Hardened Runtime 库校验。
    SIGN_ARGS=(--force --sign "$SIGN_IDENTITY" --keychain "$SIGN_KEYCHAIN" --timestamp=none)
    LOCAL_REQUIREMENT="=designated => identifier \"$LOCAL_BUNDLE_IDENTIFIER\" and certificate leaf = H\"$SIGN_IDENTITY\""
    APP_SIGN_ARGS=("${SIGN_ARGS[@]}" --requirements "$LOCAL_REQUIREMENT")
    ;;
  distribution)
    SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"
    if [ "$SIGN_IDENTITY" = "-" ]; then
      echo "不再支持 ad-hoc 本机签名；请先创建固定的 Sirius Local Development 证书并执行 scripts/sign-local.sh。" >&2
      exit 1
    fi
    SIGN_ARGS=(--force --sign "$SIGN_IDENTITY" --options runtime --timestamp)
    APP_SIGN_ARGS=("${SIGN_ARGS[@]}")
    ;;
  *)
    echo "无效的 SIGN_MODE：${SIGN_MODE}（可选 distribution 或 local）。" >&2
    exit 1
    ;;
esac

if [ ! -d "$APP" ]; then
  echo "找不到应用包：${APP}（先执行 npm run tauri build）" >&2
  exit 1
fi

if [ "$SIGN_MODE" = "local" ]; then
  INFO_PLIST="$APP/Contents/Info.plist"
  if [ ! -f "$INFO_PLIST" ]; then
    echo "应用包缺少 Info.plist：$INFO_PLIST" >&2
    exit 1
  fi
  if ! APP_BUNDLE_IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST" 2>/dev/null)"; then
    echo "无法读取应用包的 CFBundleIdentifier：$INFO_PLIST" >&2
    exit 1
  fi
  if [ "$APP_BUNDLE_IDENTIFIER" != "$LOCAL_BUNDLE_IDENTIFIER" ]; then
    echo "应用包标识不匹配：本机固定证书仅允许签名 ${LOCAL_BUNDLE_IDENTIFIER}，实际为 ${APP_BUNDLE_IDENTIFIER}。" >&2
    exit 1
  fi

  if ! command -v security >/dev/null 2>&1; then
    echo "找不到 macOS security 命令，无法解锁本机专用签名钥匙串。" >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "找不到 python3，无法安全验证并解锁本机专用签名钥匙串。" >&2
    exit 1
  fi

  # Trap 在首次解锁前就绪，确保解锁或后续 search-list 操作部分成功时也会清理。
  trap lock_local_keychain_on_exit EXIT
  LOCAL_KEYCHAIN_LOCK_REQUIRED=1
  if SEARCH_LIST_OUTPUT="$(python3 - "$SIGN_KEYCHAIN" "$LOCAL_KEYCHAIN_PATH" "$LOCAL_SIGNING_DIRECTORY" "$LOCAL_KEYCHAIN_PASSWORD_FILE" <<'PY'
import os
import shlex
import stat
import subprocess
import sys

keychain_path, expected_keychain_path, signing_directory, password_path = sys.argv[1:]
added_search_item = False
helper_error = None

def run_security(arguments, label):
    try:
        result = subprocess.run(
            ["security", *arguments],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        raise RuntimeError(f"无法执行 security {label}：{error}") from error
    if result.returncode != 0:
        if result.stderr:
            sys.stderr.write(result.stderr)
        raise RuntimeError(f"security {label} 执行失败。")
    return result

def fail(message):
    raise RuntimeError(message)

try:
    if keychain_path != expected_keychain_path:
        fail("本机签名钥匙串路径不符合固定配置。")

    try:
        directory_stat = os.lstat(signing_directory)
    except OSError:
        fail("本机签名目录不存在或不可读取。")
    if not stat.S_ISDIR(directory_stat.st_mode):
        fail("本机签名目录必须是普通目录，不能是符号链接。")
    if directory_stat.st_uid != os.getuid() or stat.S_IMODE(directory_stat.st_mode) != 0o700:
        fail("本机签名目录必须归当前用户所有且权限为 700。")

    def validate_private_file(path, exact_mode=None):
        try:
            file_stat = os.lstat(path)
        except OSError:
            fail("本机签名钥匙串或密码文件不存在或不可读取。")
        if not stat.S_ISREG(file_stat.st_mode):
            fail("本机签名钥匙串和密码必须是普通文件，不能是符号链接。")
        mode = stat.S_IMODE(file_stat.st_mode)
        if file_stat.st_uid != os.getuid() or mode & 0o077:
            fail("本机签名钥匙串和密码文件必须归当前用户所有且禁止其他用户访问。")
        if exact_mode is not None and mode != exact_mode:
            fail("本机专用钥匙串密码文件权限必须为 600。")
        if exact_mode is None and mode & 0o600 != 0o600:
            fail("本机专用签名钥匙串必须允许当前用户读写。")

    validate_private_file(keychain_path)
    validate_private_file(password_path, 0o600)

    try:
        with open(password_path, "rb") as password_file:
            password = password_file.read().decode("utf-8")
    except (OSError, UnicodeError):
        fail("无法安全读取本机专用钥匙串密码。")
    if password.endswith("\n"):
        password = password[:-1]
        if password.endswith("\r"):
            password = password[:-1]
    if not password or "\x00" in password:
        fail("本机专用钥匙串密码文件内容无效。")

    try:
        result = subprocess.run(
            ["security", "unlock-keychain", "-p", password, keychain_path],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        fail(f"无法执行 security unlock-keychain：{error}")
    if result.returncode != 0:
        if result.stderr:
            sys.stderr.buffer.write(result.stderr)
        raise RuntimeError("security unlock-keychain 执行失败。")

    # codesign 还会从当前用户 search list 查找 identity；只在本项缺失时临时追加，绝不重置其余顺序。
    current = run_security(["list-keychains", "-d", "user"], "list-keychains")
    try:
        current_paths = shlex.split(current.stdout)
    except ValueError as error:
        fail(f"无法解析当前用户钥匙串搜索列表：{error}")
    if keychain_path not in current_paths:
        try:
            run_security(
                ["list-keychains", "-d", "user", "-s", *current_paths, keychain_path],
                "list-keychains 更新",
            )
        except RuntimeError:
            # setter 失败时可能已完成写入；检查实时状态，以便 EXIT trap 能撤回部分成功。
            try:
                observed = run_security(["list-keychains", "-d", "user"], "list-keychains")
                added_search_item = keychain_path in shlex.split(observed.stdout)
            except (RuntimeError, ValueError):
                added_search_item = True
            raise
        added_search_item = True
except RuntimeError as error:
    helper_error = str(error)
finally:
    # stdout 只传递非秘密清理状态，不输出钥匙串列表、密码或 security 参数。
    print(f"added={1 if added_search_item else 0}", flush=True)

if helper_error is not None:
    print(helper_error, file=sys.stderr)
    raise SystemExit(1)
PY
  )"; then
    case "$SEARCH_LIST_OUTPUT" in
      added=0) LOCAL_SEARCH_ITEM_ADDED=0 ;;
      added=1) LOCAL_SEARCH_ITEM_ADDED=1 ;;
      *)
        echo "本机专用钥匙串 helper 返回无效清理状态。" >&2
        exit 1
        ;;
    esac
  else
    helper_status=$?
    case "$SEARCH_LIST_OUTPUT" in
      added=1) LOCAL_SEARCH_ITEM_ADDED=1 ;;
      added=0) LOCAL_SEARCH_ITEM_ADDED=0 ;;
    esac
    echo "无法解锁本机专用签名钥匙串。" >&2
    exit "$helper_status"
  fi

  # 有效身份检查限定在专用钥匙串，且按 SHA-1 与证书名称精确匹配。
  if ! IDENTITY_OUTPUT="$(security find-identity -v -p codesigning "$SIGN_KEYCHAIN" 2>/dev/null)"; then
    echo "无法读取本机专用代码签名身份。" >&2
    exit 1
  fi
  if ! IDENTITY_OUTPUT="$IDENTITY_OUTPUT" python3 - "$SIGN_IDENTITY" "$LOCAL_COMMON_NAME" <<'PY'
import os
import re
import sys

expected_sha1 = sys.argv[1].upper()
expected_common_name = sys.argv[2]
identity_rows = os.environ.get("IDENTITY_OUTPUT", "").splitlines()
for row in identity_rows:
    if not re.match(r"^\s*\d+\)", row):
        continue
    fingerprints = re.findall(r"(?i)(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])", row)
    quoted_names = re.findall(r'"([^"]*)"', row)
    if (
        expected_sha1 in (fingerprint.upper() for fingerprint in fingerprints)
        and expected_common_name in quoted_names
    ):
        break
else:
    raise SystemExit(1)
PY
  then
    echo "未找到有效的专用签名身份 Sirius Local Development（指纹不匹配、私钥不可用或代码签名信任未通过）；不会改用 ad-hoc 签名。" >&2
    exit 1
  fi
fi

echo "==> 1/4 签名全部捆绑的 dylib（顺序：依赖库先于可执行文件）"
find "$APP/Contents/Frameworks" -type f -name "*.dylib" -print0 | while IFS= read -r -d '' dylib; do
  codesign "${SIGN_ARGS[@]}" "$dylib"
done

echo "==> 2/4 签名应用包与 Entitlements"
codesign "${APP_SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$APP"

if [ "$SIGN_MODE" = "local" ]; then
  echo "==> 本机签名校验"
  codesign --verify --deep --strict --verbose=2 "$APP"

  # 要求 DR 同时固定应用标识和证书叶节点 SHA-1，防止退化成只绑定 cdhash 的 ad-hoc 签名。
  if ! DESIGNATED_REQUIREMENT="$(codesign -d -r- "$APP" 2>&1)"; then
    echo "无法读取本机签名的 designated requirement。" >&2
    exit 1
  fi
  if ! DESIGNATED_REQUIREMENT="$DESIGNATED_REQUIREMENT" python3 - "$LOCAL_BUNDLE_IDENTIFIER" "$SIGN_IDENTITY" <<'PY'
import os
import re
import sys

bundle_identifier = sys.argv[1]
certificate_sha1 = sys.argv[2].upper()
requirement = os.environ.get("DESIGNATED_REQUIREMENT", "")
designated_match = re.search(r"\bdesignated\s*=>\s*(.*)", requirement, re.IGNORECASE | re.DOTALL)
if designated_match is None:
    raise SystemExit(1)
designated_requirement = designated_match.group(1)
identifier_pattern = rf'\bidentifier\s+"{re.escape(bundle_identifier)}"'
certificate_pattern = (
    rf'\bcertificate\s+leaf\s*=\s*H?"?{re.escape(certificate_sha1)}"?'
)
if not re.search(identifier_pattern, designated_requirement, re.IGNORECASE):
    raise SystemExit(1)
if not re.search(certificate_pattern, designated_requirement, re.IGNORECASE):
    raise SystemExit(1)
PY
  then
    echo "本机签名 DR 未绑定 com.sirius.desktop 与固定证书指纹，拒绝接受该签名。" >&2
    exit 1
  fi

  echo "完成：$APP 已使用固定本机证书签名并通过校验。"
  exit 0
fi

echo "==> 3/4 提交公证（notarytool）"
PROFILE="sirius-notary-profile"
if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  xcrun notarytool store-credentials "$PROFILE" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER"
  SUBMIT_ARGS=(--key-profile "$PROFILE")
elif [ -n "${APPLE_ID:-}" ]; then
  xcrun notarytool store-credentials "$PROFILE" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID"
  SUBMIT_ARGS=(--key-profile "$PROFILE")
else
  echo "未设置公证凭据（APPLE_API_KEY_PATH 或 APPLE_ID），跳过公证，仅完成签名。" >&2
  echo "==> 4/4 校验签名"
  codesign --verify --strict --verbose=2 "$APP"
  exit 0
fi

ZIP_PATH="${APP%/}.zip"
ditto -c -k --keepParent "$APP" "$ZIP_PATH"
xcrun notarytool submit "$ZIP_PATH" "${SUBMIT_ARGS[@]}" --wait

echo "==> 4/4 装订票据并校验"
xcrun stapler staple "$APP"
codesign --verify --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"

echo "完成：$APP 已签名、公证并装订。"
