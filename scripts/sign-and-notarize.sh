#!/usr/bin/env bash
# Developer ID 签名 + 公证 + 装订（第 6 步收尾）。
#
# 前置条件：
#   1. 已构建 release 包：npm run tauri build
#   2. 钥匙串中存在 "Developer ID Application" 证书（含私钥）
#   3. 公证凭据二选一：
#      方式 A（推荐）App Store Connect API Key：
#        export APPLE_API_KEY_PATH=/absolute/path/AuthKey_XXXXXXXXXX.p8
#        export APPLE_API_KEY_ID=XXXXXXXXXX
#        export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#      方式 B Apple ID + App 专用密码：
#        export APPLE_ID=you@example.com
#        export APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx
#        export APPLE_TEAM_ID=XXXXXXXXXX
#
# 用法：./scripts/sign-and-notarize.sh [APP 路径]
#   默认 APP=src-tauri/target/release/bundle/macos/Sirius.app
#
# 脚本不保存任何秘密；所有凭据仅经环境变量传给 xcrun。
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Sirius.app}"
SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"
ENTITLEMENTS="$(dirname "$0")/../src-tauri/entitlements.plist"

if [ ! -d "$APP" ]; then
  echo "找不到应用包：$APP（先执行 npm run tauri build）" >&2
  exit 1
fi

echo "==> 1/4 签名全部捆绑的 dylib（顺序：依赖库先于可执行文件）"
find "$APP/Contents/Frameworks" -type f -name "*.dylib" -print0 | while IFS= read -r -d '' dylib; do
  codesign --force --options runtime --timestamp \
    --sign "$SIGN_IDENTITY" "$dylib"
done

echo "==> 2/4 签名应用包（Hardened Runtime + Entitlements）"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" "$APP"

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
