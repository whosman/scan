#!/bin/sh
# Build the engine to WebAssembly: app/engine-simd.wasm (SIMD, for current browsers) and app/engine.wasm (for older ones).
# Needs Rust with the wasm32 target:  rustup target add wasm32-unknown-unknown
set -e
cd "$(dirname "$0")"
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/hwscan_engine.wasm ../app/engine-simd.wasm
RUSTFLAGS="" cargo build --release --target wasm32-unknown-unknown --target-dir target-nosimd
cp target-nosimd/wasm32-unknown-unknown/release/hwscan_engine.wasm ../app/engine.wasm
ls -l ../app/engine*.wasm
