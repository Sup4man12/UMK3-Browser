# ADR-0001: FBNeo com frontend WASM próprio (sem libretro/RetroArch)

- Status: aceito
- Data: 2026-11-13

## Contexto

Precisamos rodar o arcade UMK3 Plus no navegador, com controle explícito de frames, áudio, inputs e save
state, e com determinismo suficiente para um netcode delay-based no futuro.

Fatos verificados no código-fonte do FBNeo (commit `2c6dac37`):

- O driver `umk3p` já existe (`d_wunit.cpp`) e está marcado como funcional.
- O build oficial usa Meson e permite compilar só um driver (`-Ddriver_list=midway/d_wunit.cpp`), mas o
  executável final sempre inclui um frontend desktop (SDL2, Qt, Win32...) e a camada "burner"
  (zip/7z, CHD, Lua, interfaces de vídeo e áudio).
- A biblioteca de emulação (`burn`, CPUs, sons, drivers) depende de poucos símbolos do frontend: replay,
  romdata, IPS, caminho de hiscore e divisor de mouse.
- O port libretro não está mais no repositório upstream; ele vive no fork `libretro/FBNeo`.

## Alternativas consideradas

| Opção | Prós | Contras |
|---|---|---|
| **FBNeo + frontend C++ mínimo (escolhida)** | Binário pequeno (568 KiB, um driver); API sob nosso controle (frame a frame, ROMs da memória, save state em buffer, semente fixa); um único patch de 14 linhas no Meson | Mantemos ~500 linhas de C++ e um patch sobre o upstream |
| Core libretro do FBNeo + frontend libretro próprio em JS | API padronizada (`retro_run`, `retro_serialize`) | Fork separado, build com Makefile próprio; inclui todos os drivers por padrão; a camada libretro não traz nada que precisemos |
| RetroArch web / EmulatorJS | Pronto para uso | Controla o loop principal e o canvas; integrar input por frame e netcode próprio exigiria contornar o frontend; payload grande |
| MAME (emscripten oficial) | Driver `umk3`, suporte de longa data | Build WASM gigante; o UMK3+ exige alterar o driver no MAME (as 4 ROMs gráficas novas); loop controlado pelo MAME |

## Decisão

Compilar a biblioteca de emulação do FBNeo com o Meson upstream, adicionando um frontend `wasm`
(`emulator/patches/0001-meson-add-wasm-frontend.patch`) que, quando selecionado, liga apenas `cpu`, `burn`,
`devices`, `snd` e `drv` ao nosso `emulator/core/fbneo_core.cpp`, e não processa o restante do
`meson.build` (`subdir_done()`).

Os símbolos do frontend que o `burn` exige são definidos em `emulator/core/frontend_shims.cpp`, cada um
documentado como "recurso desativado" (por exemplo, `bDoIpsPatch = false`), nunca como implementação falsa.

## Consequências

- Atualizar o FBNeo = trocar `FBNEO_COMMIT`/`FBNEO_SHA256` em `build-wasm.sh` e reaplicar o patch.
- Novos jogos de outros hardwares exigem só mudar `DRIVER_LIST`; o frontend é genérico (inputs mapeados pelos
  nomes `"pN up"`, `"pN fire 1"` etc. que o FBNeo usa).
- **Licença do FBNeo**: proíbe obter qualquer lucro, inclusive pedir doações, em projetos que usem o código;
  exige publicar as modificações e distribuir o texto da licença com o binário (`FBNEO-LICENSE.txt` é
  publicado ao lado do `.wasm`). Isso restringe o modelo de negócio da plataforma inteira enquanto ela usar o FBNeo.
