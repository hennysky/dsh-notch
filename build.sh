#!/usr/bin/env bash
# 构建 DSHNotch.app
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain.sh
source "$HERE/toolchain.sh"

APP="$HERE/build/DSHNotch.app"
CONTENTS="$APP/Contents"

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

SOURCES=("$HERE"/Sources/*.swift)
echo "编译 ${#SOURCES[@]} 个源文件 → $APP"
dsh_swiftc -O "${SOURCES[@]}" -o "$CONTENTS/MacOS/DSHNotch"

cp "$HERE/Resources/Info.plist" "$CONTENTS/Info.plist"
printf 'APPL????' > "$CONTENTS/PkgInfo"

# ad-hoc 签名：本机运行足够，不需要开发者证书
if codesign --force --sign - "$APP" 2>/dev/null; then
  echo "✓ ad-hoc 签名完成"
else
  echo "⚠️  ad-hoc 签名失败（本机通常仍可运行）"
fi

echo
echo "✓ 构建完成：$APP"
echo "  启动： open '$APP'"
echo "  自检： '$CONTENTS/MacOS/DSHNotch' --selftest"
