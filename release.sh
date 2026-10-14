#!/usr/bin/env bash
# 打包可分发版本：构建 .app → 压缩成 zip
# 用法： ./release.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain.sh
source "$HERE/toolchain.sh"

APP="$HERE/build/DSHNotch.app"
DIST="$HERE/dist"

"$HERE/build.sh" >/dev/null

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ZIP="$DIST/DSHNotch-$VERSION.zip"

mkdir -p "$DIST"
rm -f "$ZIP"

# 用 ditto 而不是 zip：能正确保留代码签名、扩展属性与资源分支
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

MINOS="$(otool -l "$APP/Contents/MacOS/DSHNotch" | awk '/minos/{print $2; exit}')"
ARCH="$(lipo -info "$APP/Contents/MacOS/DSHNotch" | sed 's/.*: //')"

echo "✓ 打包完成"
echo "  文件      $ZIP"
echo "  大小      $(du -h "$ZIP" | cut -f1)"
echo "  架构      $ARCH"
echo "  最低系统  macOS $MINOS"
echo "  版本      $VERSION"
echo
echo "发布到 GitHub："
echo "  gh release create v$VERSION '$ZIP' --title 'v$VERSION' --notes-from-tag"
