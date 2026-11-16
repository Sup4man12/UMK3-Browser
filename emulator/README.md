# emulator/: FBNeo para WebAssembly

Compila apenas a biblioteca de emulação do [FinalBurn Neo](https://github.com/finalburnneo/FBNeo), com o
driver Midway Wolf-unit (`d_wunit.cpp`, que contém `umk3p`), e um frontend C++ mínimo para WebAssembly.

## Requisitos

- Linux ou macOS com `bash`, `curl`, `tar`, `patch`, `sha256sum`, `perl`
- `meson` ≥ 1.1 e `ninja`
- Compilador C/C++ nativo (o build gera ferramentas auxiliares do FBNeo que rodam no host)
- Emscripten **7.0.0**, instalado pelo script abaixo em `emulator/.emsdk` (ignorado pelo git)

## Uso

```bash
./emulator/scripts/setup-emsdk.sh   # uma vez: baixa e ativa o emsdk 7.0.0
./emulator/build-wasm.sh            # build incremental
./emulator/build-wasm.sh --clean    # do zero
```

Saída em `emulator/dist/`, copiada para `apps/web/public/emulator/`:

| Arquivo | Conteúdo |
|---|---|
| `fbneo_core.mjs` | módulo ES6 do Emscripten (`createFbneoCore`), ambiente `worker,node` |
| `fbneo_core.wasm` | core (~568 KiB) |
| `build-info.json` | commit do FBNeo, versão do emcc, SHA-256 do wasm (base para validar compatibilidade entre pares no netcode) |
| `FBNEO-LICENSE.txt` | licença do FBNeo, que deve acompanhar o binário |

Build limpo validado: ~10 s em 16 threads. Dois builds limpos geraram o mesmo SHA-256 do `.wasm`.

## Como funciona

1. Baixa o tarball do FBNeo no commit fixado (`FBNEO_COMMIT`) e confere o `FBNEO_SHA256`.
2. Extrai em `emulator/fbneo/` e aplica `patches/*.patch`.
   - `0001-meson-add-wasm-frontend.patch`: adiciona a opção `-Dfrontend=wasm`. Com ela, o `meson.build` raiz
     entra em `src/burner/wasm` logo após montar as bibliotecas de emulação e para ali (`subdir_done()`),
     sem compilar a camada desktop (zip/7z, CHD, Lua, SDL).
3. Copia `core/` para `src/burner/wasm/` e o `tchar.h` POSIX do frontend headless do próprio FBNeo.
4. Configura o Meson com o cross-file do Emscripten:
   `-Dfrontend=wasm -Ddriver_list=midway/d_wunit.cpp -Dinclude_7z=false -Dfastcall_support=false --buildtype=release`.

## Arquivos do frontend (`core/`)

- `fbneo_core.cpp`: API `core_*` (ver [docs/architecture.md](../docs/architecture.md#api-c-do-core-emulatorcorefbneo_corecpp)).
  ROMs vêm de buffers em memória (`BurnExtLoadRom`), vídeo 32bpp é convertido para RGBA, áudio int16 estéreo,
  DIPs de fábrica aplicados com a mesma lógica do `InpDIPSWResetDIPs()` do FBNeo e save state via `BurnAreaScan`.
- `frontend_shims.cpp`: símbolos que o `burn` espera do frontend desktop. Todos representam "recurso
  desativado". O único com efeito é `is_netgame_or_recording() = 1`, que fixa a semente do RNG e a data
  emulada ([ADR-0004](../docs/adr/0004-determinism-for-delay-based-netcode.md)).
- `meson.build`: flags de link do Emscripten (`MODULARIZE`, `EXPORT_ES6`, `FILESYSTEM=0`, memória crescível
  a partir de 64 MiB).

## Limitações conhecidas do core

- Hiscore, cheats, IPS embutido, RomData e gravação de replays do FBNeo não estão disponíveis (dependem do burner).
- NVRAM/CMOS (configurações do operador, que no UMK3+ incluem as opções de balanceamento) começa vazia.
  `core_nvram_load` carrega um dump cru (o app usa `data/nvram/umk3p.fs` quando existe) e `core_nvram_size/save`
  leem a NVRAM; sem arquivo, o app gera a CMOS de fábrica (`apps/web/src/game/firstBoot.ts`). Nada é gravado de
  volta em disco.
- Inputs analógicos e mouse não são mapeados (o UMK3 não usa).
- `core_reset()` usa o input "reset" do driver; drivers sem ele retornam erro.
