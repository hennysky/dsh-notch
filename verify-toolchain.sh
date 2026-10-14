#!/usr/bin/env bash
# 验证 Swift 工具链是否可用（编译 + 运行冒烟测试）。
# 用法： ./verify-toolchain.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain.sh
source "$HERE/toolchain.sh"

OUT="${DSH_NOTCH_MODCACHE}/toolchain-smoke"

VERSION_LINE="$("$SWIFTC" --version 2>/dev/null | sed -n '1p' || true)"
echo "工具链 : $SWIFTC"
echo "版本   : ${VERSION_LINE:-未知}"
echo "SDK    : $DSH_NOTCH_SDK"
echo

dsh_swiftc -O "$HERE/tools/toolchain-smoke.swift" -o "$OUT"
echo "✓ 编译成功 → $OUT"
echo
"$OUT"
