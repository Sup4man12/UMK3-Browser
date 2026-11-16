# Arquitetura

## Visão geral

```
 Thread principal (React)                 GameWorker (Web Worker)                    AudioWorklet
 ───────────────────────                  ───────────────────────                    ────────────
 PlayPage / componentes                   EmulatorAdapter ──► fbneo_core.wasm
   │  zustand (gameStore)                   │   (FBNeo burn + driver Wolf-unit)
   ▼                                        │
 GameRuntime ──GameCommand──────────────►  loop FramePacer @ 54,71 Hz
   ▲  InputManager (teclado)                │   setInput → runFrame → vídeo/áudio
   │                                        ├─ putImageData ──► OffscreenCanvas (canvas na página)
   └────────────GameEvent────────────────  ├─ int16 estéreo ──MessagePort──────────► StereoRingBuffer → saída
                                            └─ resolveRomSet: unzip + CRC32 + IPS
```

- O React só renderiza estado e envia comandos. Nenhum código de emulação roda na thread principal.
- O worker é o dono do relógio e da ordem dos frames, o que é necessário para o netcode futuro.
- O core WASM não tem relógio, sistema de arquivos nem estado global de tempo: cada `core_run_frame()` avança
  exatamente um frame.

## Fluxo de execução

1. `GameCanvas` cria o `<canvas>`, transfere o controle para o worker e instancia o `GameRuntime`.
2. `INIT`: o worker importa `/emulator/fbneo_core.mjs`, chama `core_init`, seleciona `umk3p` e responde
   `CORE_READY`. O `GameRuntime` já envia `LOAD_GAME` em seguida; o worker processa os comandos em fila.
3. `LOAD_GAME`: o worker lê a lista em `/roms/` (servida de `data/roms/` pelo plugin do Vite, só em dev/preview),
   baixa os arquivos, extrai, verifica e monta as ROMs (`ROMS_CHECKED`). Com o set completo, copia-as para o
   WASM e chama `core_start(48000)`. Em seguida, a CMOS: se `/nvram/umk3p.fs` existir (servido de
   `data/nvram/`) com 32 KiB, é carregado com `core_nvram_load` antes do primeiro frame. Senão, `initializeCmos`
   emula o primeiro boot fora da tela até a CMOS de fábrica ser gravada (~300 frames) e pede reset, para evitar a
   tela "CMOS INVALID". O estado resultante vira o snapshot de boot. Depois disso o worker envia `GAME_STARTED`
   (com a origem da CMOS), e a página envia `START` automaticamente.
4. No primeiro clique ou tecla (exigência de gesto do navegador), o `GameRuntime` cria o `AudioContext` a
   48 kHz e o AudioWorklet e envia `SET_AUDIO` com a porta; até lá o jogo roda mudo.
5. `START` inicia o loop; `PAUSE`, `STEP` (1 frame), `RESET`, `SAVE_STATE`/`LOAD_STATE` controlam a execução.
6. `STATS` é publicado a cada segundo: fps medido, custo médio de `core_run_frame` e frames descartados.

## API C do core (`emulator/core/fbneo_core.cpp`)

| Função | Descrição |
|---|---|
| `core_init()` | `BurnLibInit` |
| `core_select_driver(name)` | seleciona o driver e prepara a tabela de ROMs |
| `core_rom_count/name/length/crc/type(i)` | lista de ROMs do driver |
| `core_set_rom(i, ptr, len)` | entrega uma ROM (o core assume o buffer) |
| `core_start(sampleRate)` | `BurnDrvInit`, DIPs de fábrica, buffers de vídeo e áudio, mapa de inputs |
| `core_set_input(player, mask)` / `core_set_system_input(mask)` | inputs (bits em `shared/protocol/src/buttons.ts`) |
| `core_run_frame(render)` | emula 1 frame (sem desenhar se `render = 0`) |
| `core_video_buffer()` / `core_audio_buffer()` | RGBA8888 e int16 estéreo intercalado |
| `core_state_size/save/load` | save state completo em memória |
| `core_nvram_size/save/load` | lê/substitui só a NVRAM (CMOS, 32 KiB), que sobrevive ao reset; `load` antes do boot aplica um `.fs` |
| `core_reset()` | reset de hardware no próximo frame (input "reset" do driver) |
| `core_stop()` | `BurnDrvExit` e liberação de memória |

## Estrutura do repositório

```
apps/web/                 React + TypeScript + Vite
  src/game/               runtime do jogo (isolado do React, exceto GameCanvas)
    GameRuntime.ts        fachada na thread principal
    GameWorker.ts         worker: core, loop, vídeo, áudio
    EmulatorAdapter.ts    wrapper tipado do módulo WASM (sem DOM; roda também em Node)
    FramePacer.ts         agendador de passo fixo (testado)
    InputManager.ts       teclado → máscara do jogador local (testado)
    firstBoot.ts          CMOS de fábrica, snapshot de boot, hash do estado
    messages.ts           contratos GameCommand / GameEvent
    netplay/Lockstep.ts   lockstep delay-based (testado com rede simulada)
    audio/                ring buffer (testado), worklet, contrato de áudio
    rom/                  crc32, ips, romset (testados)
  src/hooks/useFullscreen.ts  tela cheia do elemento da tela do jogo
  src/net/                NetplayClient (sala, Enter, RTT, notificações; testado), PeerLink (WebRTC + relay)
  src/stores, pages, components
  tests/                  integração com o core WASM real (inclui lockstep entre dois cores)
apps/api/                 Spring Boot 4.1 (Java 21): módulo signaling (Room, SignalingHandler; testado)
shared/protocol/          botões, mensagens binárias de netplay e mensagens JSON de signaling (testados)
emulator/                 build WASM do FBNeo (ver emulator/README.md)
docs/                     ADRs, ROMs, arquitetura
```

Diferenças em relação à estrutura de referência e motivo:

- `src/workers/` não foi criado: o único worker é `game/GameWorker.ts`. `src/hooks/` só tem `useFullscreen`.
- `src/services/` virou `src/net/`: a única comunicação com o servidor é o signaling do netplay.
- `apps/api` tem só o módulo `signaling` (o único necessário agora). `infra/` e `docker-compose.yml` seguem
  adiados ([ADR-0005](adr/0005-backend-deferred.md)): não há Docker nesta máquina para validá-los.
- `emulator/fbneo/` não é versionado: é extraído de um tarball fixado por commit e SHA-256 a cada build limpo.

## Netplay

Detalhes e justificativas em [ADR-0006](adr/0006-netplay-rooms-lockstep-transport.md).

```
 Navegador A (Player 1)                   apps/api (signaling)                 Navegador B (Player 2)
 GameWorker ⇄ GameRuntime/NetplayClient ⇄ WebSocket /ws/signaling?room=… ⇄ NetplayClient ⇄ GameWorker
     │            │  hello, ready (Enter)   Room: slots por chegada,          │
     │            │  ◄ welcome, peer-joined/left, ready-state, match-start    │
     │            └──── WebRTC DataChannel (inputs, ping, hash) ─────────────┘
     │                 └─ reserva: frames binários repassados pelo WebSocket
     └─ Lockstep: frame F roda só com os inputs dos dois; input local vale para F + delay
```

1. Ao terminar de carregar o jogo, a página entra na sala (`?room=`, padrão `local`) e envia o build do core. O jogo
   já roda offline.
2. O servidor numera por chegada e avisa os dois. O Player 1 inicia a negociação WebRTC (canais `netplay`, não
   confiável, e `sync`, confiável). Se não abrir em 5 s, ou se o adversário já fala pelo relay, os dois usam o relay.
3. Com o transporte aberto, o Player 1 mede o RTT e envia o **jogo em andamento** (`HOST_SYNC` → `sync-begin` +
   `sync-chunk`). O Player 2 carrega esse estado e os dois seguem em lockstep a partir dele. Nada de Enter.
4. Dessincronia (hashes a cada 120 frames diferentes): o Player 1 reenvia o estado.
5. Enter nos dois (`ready` → `match-start`): o Player 1 reinicia a própria máquina (snapshot de boot mais a CMOS
   atual dele, como um desligar/ligar) e a envia (`HOST_SYNC` com `restart`); o Player 2 só recebe. Assim a CMOS de
   cada jogador continua sendo só dele.
6. Saída do adversário: `MATCH_STOP`; o jogo de quem ficou continua offline e pode ser promovido a Player 1.
7. CMOS do jogador: o worker verifica a NVRAM a cada ~110 frames e, quando muda e é a CMOS do próprio jogador (não a
   máquina do Player 1 recebida ao entrar), envia `NVRAM_CHANGED`; o `GameRuntime` grava no `localStorage`
   (`nvramStore.ts`). No boot, ela tem prioridade sobre `data/nvram/umk3p.fs`.

LAN: `npm run dev:lan` serve HTTPS em todas as interfaces e repassa `/ws` para o backend (ver ADR-0006).

## Backend planejado

O módulo `signaling` já existe (sem persistência: salas em memória). Os demais são planejados.

Monólito modular Spring Boot (Java 21), um pacote por módulo em `com.umk3`:

| Módulo | Responsabilidade | Persistência |
|---|---|---|
| `auth` | login, sessão/JWT, Spring Security | PostgreSQL |
| `users` | perfil, preferências | PostgreSQL |
| `lobby` | presença online | Redis (TTL) |
| `rooms` | salas privadas, convites, configuração (input delay, hash do ROM set, versão do core) | Redis + PostgreSQL |
| `matchmaking` | fila e pareamento | Redis |
| `signaling` ✅ | salas de 2, ordem de chegada, prontos, início de partida, troca de SDP/ICE, relay binário | memória (Redis pub-sub para mais de uma instância) |
| `matches` | histórico e estatísticas, resultado reportado pelos clientes | PostgreSQL |

Infra: Nginx (estáticos do `apps/web/dist` + proxy de `/api` e `/ws`), coturn (STUN/TURN para pares atrás de
NAT simétrico), PostgreSQL, Redis, tudo via Docker Compose. O backend nunca executa emulação nem trafega
vídeo ou ROMs.
