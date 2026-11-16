# ADR-0004: Determinismo e preparação para netcode delay-based

- Status: aceito (preparação; netcode não implementado)
- Data: 2026-11-13

## Contexto

No modelo delay-based, cada cliente roda sua própria instância e só inputs trafegam. As instâncias precisam
produzir exatamente o mesmo estado para a mesma sequência de inputs.

Fontes de não determinismo encontradas no FBNeo para este driver:

- `BurnRandom()` é consumido pelo PIC de proteção serial da Midway (`midwayic.cpp`). A semente é
  `time(NULL)`, exceto quando `is_netgame_or_recording()` retorna verdadeiro: aí a semente é fixa
  (`0x303808909313`).
- `BurnGetLocalTime()` devolve a data fixa 2018-06-01 no mesmo modo.

## Decisão

- O frontend WASM define `is_netgame_or_recording()` retornando sempre `1`
  (`emulator/core/frontend_shims.cpp`). Toda instância parte do mesmo estado.
- A CMOS de fábrica é gerada emulando o primeiro boot fora da tela e dando reset (`firstBoot.ts`). Como o
  core é determinístico, todas as sessões e todos os pares partem da mesma CMOS (testado). Se a CMOS passar a
  ser persistida, ela terá de entrar no handshake do netcode.
- `core_run_frame(render)` permite emular sem desenhar (recuperação rápida) sem alterar o resultado.
- Save state em buffer (`core_state_save/load`, `ACB_FULLSCAN`) já está disponível para sincronização
  inicial, detecção de dessincronia por hash e, no futuro, rollback.
- Taxa de frames do protocolo = taxa nativa (54,71 Hz). Frame N é a unidade de tempo do jogo, não o relógio.
- Contrato binário em `shared/protocol/src/netplay.ts` (versão 2): inputs com redundância e ack, ping/pong e hash
  do estado. O `InputPacket` de um frame só, da fase 1, foi substituído (ver ADR-0006).
- O WASM é compilado sem `-ffast-math` (flags do release do Meson: `-O3`), e o core usa ponto flutuante
  IEEE do WebAssembly, determinístico entre navegadores. Determinismo entre navegadores diferentes (Chrome × Firefox) ainda não foi testado.

## Validação

Validado com ROMs reais em 2026-11-13 (`apps/web/tests/core.integration.test.ts`): duas instâncias com os
mesmos inputs geraram frames e save states idênticos ao longo de 900 frames, e load state reproduziu
exatamente os 100 frames seguintes.

## Plano para o netcode (fase futura)

1. Handshake via signaling: versão do core (`build-info.json → wasmSha256`), hash do ROM set montado,
   driver, taxa de amostragem não é relevante (não afeta a emulação), input delay e frame inicial.
2. Cada cliente agenda o input local para o frame `N + delay` e o envia com redundância (últimos K inputs
   por pacote, para tolerar perda sem retransmissão).
3. O frame N só roda quando os inputs dos dois jogadores para N existem. Se faltar, o emulador espera
   (stall) e a UI indica.
4. RTT por ping/pong no DataChannel (`unreliable`, `unordered`); jitter = desvio do RTT. O delay sugerido é
   `ceil((RTT/2 + jitter) / 18,28 ms)`.
5. Hash periódico do save state (por exemplo, a cada 60 frames) para detectar dessincronia.
6. Timeout de desconexão por ausência de pacotes (ex.: 3 s); a sessão termina com o resultado registrado no backend.
