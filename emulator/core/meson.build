# UMK3 Plus Online WebAssembly frontend. Copied into src/burner/wasm by
# emulator/build-wasm.sh and reached through the 'wasm' frontend added by
# patches/0001-meson-add-wasm-frontend.patch.

# Exported to JavaScript in addition to the EMSCRIPTEN_KEEPALIVE core_* API.
wasm_exported_functions = ['_malloc', '_free']
wasm_runtime_methods = ['HEAPU8', 'HEAP16', 'UTF8ToString', 'stringToNewUTF8']

wasm_link_args = [
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_NAME=createFbneoCore',
    '-sENVIRONMENT=worker,node',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=64MB',
    '-sSTACK_SIZE=1MB',
    '-sFILESYSTEM=0',
    '-sEXIT_RUNTIME=0',
    '-sEXPORTED_FUNCTIONS=' + ','.join(wasm_exported_functions),
    '-sEXPORTED_RUNTIME_METHODS=' + ','.join(wasm_runtime_methods),
]

executable(
    'fbneo_core',
    ['fbneo_core.cpp', 'frontend_shims.cpp'],
    name_suffix: 'mjs',
    include_directories: [global_inc],
    dependencies: [cpu_dep, burn_dep, burn_devices_dep, burn_snd_dep, burn_drv_dep],
    cpp_args: ['-Wno-write-strings'],
    link_args: wasm_link_args,
)
