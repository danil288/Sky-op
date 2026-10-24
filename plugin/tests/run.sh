#!/usr/bin/env bash
# Собирает и запускает тесты независимых от Skyrim частей плагина (Linux, нужен g++ или clang++).
# Игровую часть (Watcher.cpp, main.cpp) этот набор не проверяет: она собирается только на Windows.
set -euo pipefail
cd "$(dirname "$0")/.."

CXX="${CXX:-g++}"
OUT="${OUT_DIR:-build-tests}"
mkdir -p "$OUT"
FLAGS=(-std=c++23 -Wall -Wextra -Wpedantic -Wconversion -Wshadow -O1 -g -Isrc -pthread)

echo "== protocol_test =="
"$CXX" "${FLAGS[@]}" src/Protocol.cpp tests/protocol_test.cpp -o "$OUT/protocol_test"
"$OUT/protocol_test"

echo "== state_test =="
"$CXX" "${FLAGS[@]}" src/Protocol.cpp src/Text.cpp tests/state_test.cpp -o "$OUT/state_test"
"$OUT/state_test"

echo "== registry_test =="
"$CXX" "${FLAGS[@]}" src/Protocol.cpp tests/registry_test.cpp -o "$OUT/registry_test"
"$OUT/registry_test"

echo "== net_harness (сборка) =="
"$CXX" "${FLAGS[@]}" src/Protocol.cpp src/Net.cpp tests/net_harness.cpp -o "$OUT/net_harness"
echo "готово: $OUT/net_harness"
