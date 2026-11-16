#!/usr/bin/env bash
# Builds the FBNeo core (Midway Wolf-unit driver only) to WebAssembly.
#
#   ./build-wasm.sh            incremental build
#   ./build-wasm.sh --clean    re-extract FBNeo and rebuild from scratch
#
# Output: emulator/dist/fbneo_core.{mjs,wasm} + build-info.json, copied to
# apps/web/public/emulator/ for the web app.
set -euo pipefail

FBNEO_COMMIT="2c6dac370e119606ce50549f274138fa7d7bdf3c"
FBNEO_SHA256="842bb65ed3aae375c8b20146be4a067a111bfdd280ffcb13e93f66c571fe453d"
FBNEO_URL="https://api.github.com/repos/finalburnneo/FBNeo/tarball/${FBNEO_COMMIT}"
EMSDK_VERSION="7.0.0"
DRIVER_LIST="midway/d_wunit.cpp"

EMULATOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${EMULATOR_DIR}/.." && pwd)"
CACHE_DIR="${EMULATOR_DIR}/.cache"
SRC_DIR="${EMULATOR_DIR}/fbneo"
BUILD_DIR="${EMULATOR_DIR}/build"
DIST_DIR="${EMULATOR_DIR}/dist"
WEB_PUBLIC_DIR="${ROOT_DIR}/apps/web/public/emulator"
TARBALL="${CACHE_DIR}/fbneo-${FBNEO_COMMIT}.tar.gz"

log() { printf '\033[1;34m[build-wasm]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-wasm] %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--clean" ]]; then
	log "Removing ${SRC_DIR} and ${BUILD_DIR}"
	rm -rf "${SRC_DIR}" "${BUILD_DIR}"
fi

# --- Toolchain ---------------------------------------------------------------
if [[ -f "${EMULATOR_DIR}/.emsdk/emsdk_env.sh" ]]; then
	# shellcheck disable=SC1091
	source "${EMULATOR_DIR}/.emsdk/emsdk_env.sh" >/dev/null 2>&1
fi
command -v emcc >/dev/null || die "emcc not found. Run emulator/scripts/setup-emsdk.sh first."
for tool in meson ninja perl curl sha256sum patch; do
	command -v "${tool}" >/dev/null || die "Required tool not found: ${tool}"
done

EMCC_VERSION="$(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
if [[ "${EMCC_VERSION}" != "${EMSDK_VERSION}" ]]; then
	log "WARNING: emcc ${EMCC_VERSION} found, build is validated with ${EMSDK_VERSION}"
fi
EMSCRIPTEN_ROOT="$(dirname "$(command -v emcc)")"

# --- FBNeo source ------------------------------------------------------------
mkdir -p "${CACHE_DIR}"
if [[ ! -f "${TARBALL}" ]]; then
	log "Downloading FBNeo ${FBNEO_COMMIT}"
	curl -sSL --fail -o "${TARBALL}.part" "${FBNEO_URL}"
	mv "${TARBALL}.part" "${TARBALL}"
fi
echo "${FBNEO_SHA256}  ${TARBALL}" | sha256sum -c --quiet - \
	|| die "Checksum mismatch for ${TARBALL}. Delete it and retry; if it persists GitHub changed the archive format and FBNEO_SHA256 must be re-validated."

PATCH_STAMP="$(cat "${EMULATOR_DIR}"/patches/*.patch | sha256sum | cut -c1-16)"
PREPARED_MARKER="${SRC_DIR}/.umk3-prepared"
EXPECTED_MARKER="${FBNEO_COMMIT} ${PATCH_STAMP}"
if [[ ! -f "${PREPARED_MARKER}" || "$(cat "${PREPARED_MARKER}")" != "${EXPECTED_MARKER}" ]]; then
	log "Extracting FBNeo and applying patches"
	rm -rf "${SRC_DIR}" "${BUILD_DIR}"
	mkdir -p "${SRC_DIR}"
	tar -xzf "${TARBALL}" -C "${SRC_DIR}" --strip-components=1
	for p in "${EMULATOR_DIR}"/patches/*.patch; do
		log "  patch $(basename "${p}")"
		patch -d "${SRC_DIR}" -p1 --forward --quiet < "${p}"
	done
	echo "${EXPECTED_MARKER}" > "${PREPARED_MARKER}"
fi

# Our frontend is overlaid on every run so edits in emulator/core are picked up.
mkdir -p "${SRC_DIR}/src/burner/wasm"
cp "${EMULATOR_DIR}"/core/* "${SRC_DIR}/src/burner/wasm/"
# FBNeo's own POSIX TCHAR shim (burnint.h includes "tchar.h" from the frontend dir).
cp "${SRC_DIR}/src/burner/headless/tchar.h" "${SRC_DIR}/src/burner/wasm/tchar.h"

# --- Configure & build -------------------------------------------------------
CROSS_FILE="${BUILD_DIR}.cross.ini"
sed "s#@EMSCRIPTEN_ROOT@#${EMSCRIPTEN_ROOT}#g" "${EMULATOR_DIR}/emscripten-cross.ini.in" > "${CROSS_FILE}"

if [[ ! -f "${BUILD_DIR}/build.ninja" ]]; then
	log "Configuring Meson (driver_list=${DRIVER_LIST})"
	meson setup "${BUILD_DIR}" "${SRC_DIR}" \
		--cross-file "${CROSS_FILE}" \
		--buildtype=release \
		-Db_ndebug=true \
		-Dfrontend=wasm \
		-Ddriver_list="${DRIVER_LIST}" \
		-Dinclude_7z=false \
		-Dfastcall_support=false
fi

log "Compiling"
ninja -C "${BUILD_DIR}"

# --- Publish -----------------------------------------------------------------
mkdir -p "${DIST_DIR}" "${WEB_PUBLIC_DIR}"
OUT_DIR="${BUILD_DIR}/src/burner/wasm"
cp "${OUT_DIR}/fbneo_core.mjs" "${OUT_DIR}/fbneo_core.wasm" "${DIST_DIR}/"
# The FBNeo license requires its full text to accompany every distributed binary.
cp "${SRC_DIR}/src/license.txt" "${DIST_DIR}/FBNEO-LICENSE.txt"

WASM_SHA256="$(sha256sum "${DIST_DIR}/fbneo_core.wasm" | cut -d' ' -f1)"
cat > "${DIST_DIR}/build-info.json" <<EOF
{
  "fbneoCommit": "${FBNEO_COMMIT}",
  "patchStamp": "${PATCH_STAMP}",
  "emscripten": "${EMCC_VERSION}",
  "driverList": "${DRIVER_LIST}",
  "wasmSha256": "${WASM_SHA256}"
}
EOF
cp "${DIST_DIR}"/* "${WEB_PUBLIC_DIR}/"

log "Done: $(du -h "${DIST_DIR}/fbneo_core.wasm" | cut -f1) wasm -> ${WEB_PUBLIC_DIR}"
