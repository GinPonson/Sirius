#!/usr/bin/env bash
# 使用固定专用钥匙串中的 Sirius Local Development 证书签署已构建的应用包。
# 公开证书元数据只用于固定身份参数与应用包校验；私钥仍只保存在本机钥匙串中。
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Sirius.app}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDENTITY_FILE="${HOME}/Library/Application Support/com.sirius.desktop/signing/identity.json"
SIGNING_DIRECTORY="${HOME}/Library/Application Support/com.sirius.desktop/signing"
EXPECTED_KEYCHAIN_PATH="${SIGNING_DIRECTORY}/sirius-local-signing.keychain-db"
EXPECTED_COMMON_NAME="Sirius Local Development"
EXPECTED_BUNDLE_IDENTIFIER="com.sirius.desktop"

if [ ! -r "$IDENTITY_FILE" ]; then
  echo "找不到本机签名身份元数据：${IDENTITY_FILE}；请先创建并导入 Sirius Local Development 固定证书。" >&2
  exit 1
fi

# 严格校验公开身份元数据，避免读取缺字段、错误标识、钥匙串路径或意外包含其他键的文件。
if ! METADATA_FIELDS="$(python3 - "$IDENTITY_FILE" "$EXPECTED_COMMON_NAME" "$EXPECTED_BUNDLE_IDENTIFIER" "$EXPECTED_KEYCHAIN_PATH" <<'PY'
import json
import re
import sys

metadata_path, expected_common_name, expected_bundle_identifier, expected_keychain_path = sys.argv[1:]
expected_fields = {
    "certificateSha1",
    "certificateSha256",
    "commonName",
    "bundleIdentifier",
    "keychainPath",
}
try:
    with open(metadata_path, "r", encoding="utf-8") as metadata_file:
        metadata = json.load(metadata_file)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit("签名身份元数据不是可读取的 UTF-8 JSON。")

if not isinstance(metadata, dict) or set(metadata) != expected_fields:
    raise SystemExit("签名身份元数据字段不符合固定格式。")
certificate_sha1 = metadata["certificateSha1"]
certificate_sha256 = metadata["certificateSha256"]
common_name = metadata["commonName"]
bundle_identifier = metadata["bundleIdentifier"]
keychain_path = metadata["keychainPath"]
if not isinstance(keychain_path, str) or keychain_path != expected_keychain_path:
    raise SystemExit("签名身份元数据中的 keychainPath 与固定专用钥匙串路径不一致。")
if not isinstance(certificate_sha1, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", certificate_sha1):
    raise SystemExit("签名身份元数据中的 certificateSha1 必须是 40 位十六进制值。")
if not isinstance(certificate_sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", certificate_sha256):
    raise SystemExit("签名身份元数据中的 certificateSha256 必须是 64 位十六进制值。")
if common_name != expected_common_name:
    raise SystemExit("签名身份元数据的 commonName 与固定证书名称不一致。")
if bundle_identifier != expected_bundle_identifier:
    raise SystemExit("签名身份元数据的 bundleIdentifier 与应用标识不一致。")

print(f"{certificate_sha1.upper()}\t{keychain_path}")
PY
)"; then
  echo "本机签名身份元数据无效；请检查 ${IDENTITY_FILE}。" >&2
  exit 1
fi
IFS=$'\t' read -r CERTIFICATE_SHA1 SIGN_KEYCHAIN <<< "$METADATA_FIELDS"

if [ ! -d "$APP" ]; then
  echo "找不到应用包：${APP}（先执行 npm run tauri build）" >&2
  exit 1
fi
INFO_PLIST="$APP/Contents/Info.plist"
if [ ! -f "$INFO_PLIST" ]; then
  echo "应用包缺少 Info.plist：$INFO_PLIST" >&2
  exit 1
fi
if ! APP_BUNDLE_IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST" 2>/dev/null)"; then
  echo "无法读取应用包的 CFBundleIdentifier：$INFO_PLIST" >&2
  exit 1
fi
if [ "$APP_BUNDLE_IDENTIFIER" != "$EXPECTED_BUNDLE_IDENTIFIER" ]; then
  echo "应用包标识不匹配：预期 ${EXPECTED_BUNDLE_IDENTIFIER}，实际为 ${APP_BUNDLE_IDENTIFIER}。" >&2
  exit 1
fi

export SIGN_MODE=local
export SIGN_IDENTITY="$CERTIFICATE_SHA1"
export SIGN_KEYCHAIN
printf '本机签名身份：SHA-1 %s，专用钥匙串 %s\n' "$CERTIFICATE_SHA1" "$SIGN_KEYCHAIN"
exec "$SCRIPT_DIR/sign-and-notarize.sh" "$APP"
