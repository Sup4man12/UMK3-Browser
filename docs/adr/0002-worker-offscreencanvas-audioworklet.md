# ADR-0002: Emulação em Web Worker, vídeo em OffscreenCanvas, áudio em AudioWorklet

- Status: aceito
- Data: 2026-11-13

## Contexto

A emulação não pode competir com o React pela thread principal. Também precisamos de controle explícito do
avanço de frames, que o futuro netcode vai comandar.

## Decisão

- **GameWorker** (`apps/web/src/game/GameWorker.ts`) é dono do core WASM e do relógio de frames. O loop usa
  `setTimeout` com um `FramePacer` de passo fixo na **taxa nativa do hardware, 54,71 Hz** (não 60 Hz),
  limitando a recuperação a 4 frames por tick e contabilizando frames descartados.
- **Vídeo**: o `<canvas>` é transferido com `transferControlToOffscreen()`, e o worker desenha com
  `putImageData`. O core converte a saída 32bpp do FBNeo (`0x00RRGGBB`) para RGBA; o worker copia para um
  `ImageData` próprio, pois o heap do WASM é crescível e não pode ser envolvido diretamente.
- **Áudio**: o worker envia blocos int16 estéreo (um por frame emulado) por um `MessagePort` ligado
  diretamente ao `AudioWorkletProcessor`. Nenhum dado de áudio passa pela thread do React. O processador usa
  um ring buffer com *priming* de ~55 ms e descarte dos mais antigos em overflow, absorvendo a deriva entre o
  relógio do worker e o do dispositivo de áudio.
- **Input**: `InputManager` na thread principal (eventos de teclado só existem lá) envia `SET_INPUT` apenas
  quando a máscara muda; o worker aplica a máscara corrente antes de cada frame.
- Contratos tipados: `GameCommand`/`GameEvent` (`messages.ts`) e `AudioMessage` (`audio/audio-protocol.ts`,
  separado porque o escopo do AudioWorklet não tem tipos de DOM/Worker).

## Alternativas

- `requestAnimationFrame` na thread principal: amarra o jogo a 60/120 Hz do monitor, bloqueia na UI e
  pausa em abas ocultas de forma imprevisível.
- Áudio como relógio mestre: ritmo mais estável, mas acopla a taxa de frames ao dispositivo de áudio e
  complica o lockstep do netcode. Pode ser reavaliado.
- `SharedArrayBuffer` para áudio e vídeo: menos cópias, mas exige COOP/COEP em todo o site. Não se justifica
  com ~3,5 KB de áudio e ~400 KB de vídeo por frame.

## Consequências

- Requer `OffscreenCanvas` e AudioWorklet (Chrome 69+/Firefox 105+/Safari 16.4+).
- Pequenos *clicks* de áudio são possíveis quando o worker atrasa. É o preço de não usar o áudio como relógio.
- Com o netcode, o worker continua dono do relógio; o `SET_INPUT` imediato será substituído por inputs
  agendados por frame.
