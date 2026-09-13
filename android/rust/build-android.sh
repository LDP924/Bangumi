#!/bin/bash
set -e

# ============================================================
# Bangumi ECH Proxy - Android 交叉编译脚本
#
# 用法:
#   ./build-android.sh          # 编译并复制到 jniLibs
#   ./build-android.sh --setup  # 仅安装工具链
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JNILIBS_DIR="$PROJECT_ROOT/android/app/src/main/jniLibs/arm64-v8a"
NDK_VERSION="27.1.12297006"
OPENSSL_VERSION="4.0.1"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[build]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err() { echo -e "${RED}[error]${NC} $1"; exit 1; }

# ============================================================
# 校验 OpenSSL 是否为多线程构建
#
# OpenSSL 4.0 的 Configure 对 `-static` 会隐式执行
# disable('static', 'pic', 'threads'), 使 libcrypto 以单线程 (no-threads) 编译:
# 所有内部锁/原子操作变成空实现, 多线程并发使用 (代理每个连接一个线程) 会
# 破坏 provider 内部状态并触发 SIGSEGV。
#
# 判定方式: threads_pthread.o (受 OPENSSL_THREADS 保护的实现) 是否有符号输出。
# ============================================================
verify_openssl_threads() {
    local LIB="$1"
    local TOOLCHAIN_BIN="$2"
    local OBJ="libcrypto-lib-threads_pthread.o"
    local AR_BIN="$TOOLCHAIN_BIN/llvm-ar"
    local NM_BIN="$TOOLCHAIN_BIN/llvm-nm"
    local TMP_DIR
    TMP_DIR="$(mktemp -d)"

    # 必须显式用 NDK 的 llvm 工具链, 不能回退到系统 ar/nm:
    # macOS 自带 ar 解析不了 ELF 归档 (报 not found in archive), 会得到假阴性并中止构建
    if [ ! -x "$AR_BIN" ] || [ ! -x "$NM_BIN" ]; then
        warn "NDK 工具链缺少 llvm-ar/llvm-nm: $TOOLCHAIN_BIN"
        rm -rf "$TMP_DIR"
        return 2
    fi

    if ! (cd "$TMP_DIR" && "$AR_BIN" x "$LIB" "$OBJ" 2>/dev/null) \
        || ! "$NM_BIN" --defined-only "$TMP_DIR/$OBJ" 2>/dev/null | grep -q "CRYPTO_THREAD_write_lock"; then
        rm -rf "$TMP_DIR"
        return 1
    fi

    rm -rf "$TMP_DIR"
    return 0
}

# ============================================================
# 1. 检查/安装 Rust
# ============================================================
setup_rust() {
    if ! command -v rustc &>/dev/null; then
        log "安装 Rust..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        source "$HOME/.cargo/env"
    fi

    log "Rust: $(rustc --version)"

    # 安装 Android 目标
    if ! rustup target list --installed | grep -q "aarch64-linux-android"; then
        log "安装 aarch64-linux-android 目标..."
        rustup target add aarch64-linux-android
    fi

    # 安装 cargo-ndk
    if ! command -v cargo-ndk &>/dev/null; then
        log "安装 cargo-ndk..."
        cargo install cargo-ndk
    fi

    log "Rust 工具链就绪"
}

# ============================================================
# 2. 设置 Android NDK 环境
# ============================================================
setup_ndk() {
    local ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    local NDK_DIR="$ANDROID_HOME/ndk/$NDK_VERSION"

    if [ ! -d "$NDK_DIR" ]; then
        err "NDK $NDK_VERSION 未找到: $NDK_DIR"
    fi

    export ANDROID_NDK_HOME="$NDK_DIR"
    export ANDROID_NDK_ROOT="$NDK_DIR"

    # 添加 NDK 工具链到 PATH (用于编译 OpenSSL)
    local TOOLCHAIN_BIN
    TOOLCHAIN_BIN="$(ls -d "$NDK_DIR"/toolchains/llvm/prebuilt/*/bin 2>/dev/null | head -1)"
    if [ -z "$TOOLCHAIN_BIN" ]; then
        err "NDK 工具链未找到: $NDK_DIR/toolchains/llvm/prebuilt/*/bin"
    fi
    export PATH="$TOOLCHAIN_BIN:$PATH"

    log "NDK: $NDK_DIR"
}

# ============================================================
# 3. 交叉编译 OpenSSL (带 ECH 支持)
#
# 需要手动下载 OpenSSL 源码:
#   https://github.com/openssl/openssl/releases/download/openssl-4.0.1/openssl-4.0.1.tar.gz
#   解压到 android/rust/openssl/build/openssl-4.0.1/
# ============================================================
build_openssl() {
    local OPENSSL_DIR="$SCRIPT_DIR/openssl"
    local OPENSSL_BUILD="$OPENSSL_DIR/build"
    local OPENSSL_INSTALL="$OPENSSL_DIR/install"
    local OPENSSL_SRC="$OPENSSL_BUILD/openssl-$OPENSSL_VERSION"
    local ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    local NDK_DIR="$ANDROID_HOME/ndk/$NDK_VERSION"
    local TOOLCHAIN
    local API_LEVEL=21

    # host 目录名随 NDK 版本/主机架构变化 (darwin-x86_64 / darwin-arm64 ...), 按实际存在值取
    TOOLCHAIN="$(ls -d "$NDK_DIR"/toolchains/llvm/prebuilt/* 2>/dev/null | head -1)"
    if [ -z "$TOOLCHAIN" ]; then
        err "NDK 工具链未找到: $NDK_DIR/toolchains/llvm/prebuilt/*"
    fi

    # 只有带 threads 校验标记的产物才可复用
    if [ -f "$OPENSSL_INSTALL/lib/libssl.a" ] && [ -f "$OPENSSL_INSTALL/.threads-ok" ]; then
        log "OpenSSL 已编译 (threads 已启用), 跳过"
        export OPENSSL_DIR="$OPENSSL_INSTALL"
        export OPENSSL_INCLUDE_DIR="$OPENSSL_INSTALL/include"
        export OPENSSL_LIB_DIR="$OPENSSL_INSTALL/lib"
        export OPENSSL_STATIC=1
        return
    fi

    if [ -f "$OPENSSL_INSTALL/lib/libssl.a" ]; then
        warn "检测到旧的 OpenSSL 产物 (可能是 no-threads 构建), 删除后重新编译"
        rm -rf "$OPENSSL_INSTALL"
    fi

    # 检查源码是否存在, 不存在则询问是否下载
    if [ ! -d "$OPENSSL_SRC" ]; then
        warn "OpenSSL 源码未找到: $OPENSSL_SRC"
        echo ""
        echo "  下载地址: https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"
        echo "  目标目录: android/rust/openssl/build/openssl-$OPENSSL_VERSION/"
        echo ""
        read -p "  是否自动下载? (y/N) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            mkdir -p "$OPENSSL_BUILD"
            log "下载 OpenSSL $OPENSSL_VERSION..."
            curl -L "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" | tar xz -C "$OPENSSL_BUILD"
        else
            err "请手动下载并解压到上述目录后重新运行"
        fi
    fi

    log "编译 OpenSSL $OPENSSL_VERSION (带 ECH 支持)..."
    mkdir -p "$OPENSSL_INSTALL"

    cd "$OPENSSL_SRC"

    # 配置交叉编译
    #
    # 注意: 这里不能传 -static。OpenSSL 4.0 的 Configure 视 -static 为 LDFLAGS,
    # 会隐式 disable('static', 'pic', 'threads') (且位于用户参数解析之后, 显式写
    # threads 也会被覆盖), 结果是 libcrypto 以单线程 (no-threads) 编译、所有内部锁
    # 变成空操作, 多线程代理并发使用 OpenSSL 时必崩 (SSL_CTX_new_ex → SIGSEGV)。
    # 静态库能力由 no-shared 保证 (配合 OPENSSL_STATIC=1 静态链接进 libechproxy.so)。
    ./Configure android-arm64 -D__ANDROID_API__=$API_LEVEL \
        --prefix="$OPENSSL_INSTALL" \
        --openssldir="$OPENSSL_INSTALL" \
        no-shared \
        no-tests

    # 清掉可能残留的旧编译产物, 避免沿用旧配置编译出的目标文件
    make clean >/dev/null 2>&1 || true

    make -j$(sysctl -n hw.ncpu)
    make install_sw

    # 产物自检: 单线程构建的 OpenSSL 会让 ECH 代理随机闪崩, 直接失败退出
    local VERIFY_RC=0
    verify_openssl_threads "$OPENSSL_INSTALL/lib/libcrypto.a" "$TOOLCHAIN/bin" || VERIFY_RC=$?
    if [ "$VERIFY_RC" -eq 2 ]; then
        err "NDK 工具链缺少 llvm-ar/llvm-nm, 无法校验 OpenSSL 产物: $TOOLCHAIN/bin"
    elif [ "$VERIFY_RC" -ne 0 ]; then
        err "OpenSSL 编译产物缺少多线程支持 (no-threads), 会导致代理并发崩溃, 请检查 Configure 参数"
    fi

    touch "$OPENSSL_INSTALL/.threads-ok"
    log "OpenSSL 多线程支持校验通过"

    export OPENSSL_DIR="$OPENSSL_INSTALL"
    export OPENSSL_INCLUDE_DIR="$OPENSSL_INSTALL/include"
    export OPENSSL_LIB_DIR="$OPENSSL_INSTALL/lib"
    export OPENSSL_STATIC=1

    log "OpenSSL 编译完成"
}

# ============================================================
# 4. 交叉编译 Rust 库
# ============================================================
build_rust_lib() {
    cd "$SCRIPT_DIR"

    log "编译 ech-proxy (aarch64-linux-android)..."

    cargo ndk -t arm64-v8a --platform 21 build --release 2>&1

    # 复制产物到 jniLibs
    local SO_FILE="$SCRIPT_DIR/target/aarch64-linux-android/release/libechproxy.so"

    if [ -f "$SO_FILE" ]; then
        mkdir -p "$JNILIBS_DIR"
        cp "$SO_FILE" "$JNILIBS_DIR/"
        log "已复制到 $JNILIBS_DIR/libechproxy.so"
        log "大小: $(du -h "$JNILIBS_DIR/libechproxy.so" | cut -f1)"
    else
        err "编译产物未找到: $SO_FILE"
    fi
}

# ============================================================
# Main
# ============================================================
main() {
    log "=== Bangumi ECH Proxy 编译 ==="

    if [ "$1" = "--setup" ]; then
        setup_rust
        setup_ndk
        log "工具链安装完成"
        exit 0
    fi

    setup_rust
    setup_ndk
    build_openssl
    build_rust_lib

    log "=== 编译完成 ==="
    log ""
    log "产物: $JNILIBS_DIR/libechproxy.so"
    log ""
    log "下一步:"
    log "  1. 重新编译 Android App"
    log "  2. 在 JS 中调用 enableEchProxy()"
}

main "$@"
