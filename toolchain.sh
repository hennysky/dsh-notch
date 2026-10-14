#!/usr/bin/env bash
# DSH Notch —— Swift 工具链环境
#
# 为什么需要这个文件：
#   本机 Command Line Tools 是 Xcode 16.2（CLTools_Executables 16.2.0.0.1），
#   它自带的 Swift 编译器是 6.0.3 (swiftlang-6.0.3.1.10)，
#   但它自带的 SDK MacOSX15.2.sdk 里的 stdlib 接口戳是 (swiftlang-6.0.3.1.5)。
#   两者不匹配 → 系统 /usr/bin/swiftc 编译任何 Swift 代码都会失败：
#     error: unable to load standard library for target 'arm64-apple-macosx18.0'
#     error: redefinition of module 'SwiftBridging'
#
# 解决办法：
#   本机 Homebrew 装有自洽的 Swift 6.3.3 工具链。它使用工具链自带的 stdlib，
#   不再去读 SDK 里那个版本戳对不上的 stdlib，因此可以正常配合系统 SDK 工作。
#   （已实测：SwiftUI + AppKit + 刘海几何 API 均可编译运行。）
#
# 用法：  source toolchain.sh
#         dsh_swiftc -O main.swift -o app

DSH_NOTCH_TOOLCHAIN="${DSH_NOTCH_TOOLCHAIN:-/opt/homebrew/opt/swift/bin}"
DSH_NOTCH_SDK="${DSH_NOTCH_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.2.sdk}"
DSH_NOTCH_MODCACHE="${DSH_NOTCH_MODCACHE:-/tmp/dsh-notch-modcache}"

if [ ! -x "$DSH_NOTCH_TOOLCHAIN/swiftc" ]; then
  echo "错误：找不到 Swift 工具链：$DSH_NOTCH_TOOLCHAIN/swiftc" >&2
  echo "备选方案：安装完整 Xcode，或重新安装与系统版本匹配的 Command Line Tools。" >&2
  return 1 2>/dev/null || exit 1
fi

if [ ! -d "$DSH_NOTCH_SDK" ]; then
  echo "错误：找不到 SDK：$DSH_NOTCH_SDK" >&2
  return 1 2>/dev/null || exit 1
fi

mkdir -p "$DSH_NOTCH_MODCACHE"

export DSH_NOTCH_TOOLCHAIN DSH_NOTCH_SDK DSH_NOTCH_MODCACHE
export SWIFTC="$DSH_NOTCH_TOOLCHAIN/swiftc"
export PATH="$DSH_NOTCH_TOOLCHAIN:$PATH"

# 统一构建入口：始终显式指定 SDK 与可写模块缓存，避免读到错误工具链或只读缓存目录。
dsh_swiftc() {
  "$SWIFTC" -sdk "$DSH_NOTCH_SDK" -module-cache-path "$DSH_NOTCH_MODCACHE" "$@"
}

export -f dsh_swiftc
