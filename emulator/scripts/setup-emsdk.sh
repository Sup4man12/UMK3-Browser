#!/usr/bin/env bash
# Installs the pinned Emscripten SDK into emulator/.emsdk (ignored by git).
set -euo pipefail

EMSDK_VERSION="7.0.0"

EMULATOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${EMULATOR_DIR}/.emsdk"

if [[ ! -x "${EMSDK_DIR}/emsdk" ]]; then
	echo "Downloading emsdk into ${EMSDK_DIR}"
	mkdir -p "${EMSDK_DIR}"
	curl -sSL --fail https://api.github.com/repos/emscripten-core/emsdk/tarball/main \
		| tar -xz -C "${EMSDK_DIR}" --strip-components=1
fi

"${EMSDK_DIR}/emsdk" install "${EMSDK_VERSION}"
"${EMSDK_DIR}/emsdk" activate "${EMSDK_VERSION}"
echo "emsdk ${EMSDK_VERSION} ready. build-wasm.sh sources it automatically."
