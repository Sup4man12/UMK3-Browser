# UMK3 Plus Online

Plataforma web para jogar **Ultimate Mortal Kombat 3 Plus** (hack de fãs do arcade, Beta 2) no navegador,
inclusive online entre dois jogadores. O jogo roda localmente em cada navegador (FBNeo compilado para
WebAssembly); só os inputs trafegam, por WebRTC, com netcode delay-based. O servidor (Spring Boot) faz apenas
o signaling: nunca executa a emulação nem transmite vídeo.

## Estado atual

| Item | Estado | Evidência |
|---|---|---|
| FBNeo → WASM (driver Wolf-unit, inclui `umk3p`) | ✅ | `emulator/build-wasm.sh`, build limpo reproduzível |
| Jogo rodando no navegador com ROMs reais | ✅ | Firefox 160: ~54,7 FPS, 2–3 ms/frame; boot direto, sem tela de CMOS |
| Verificação de ROM por CRC + patch IPS | ✅ | testes; parser validado contra os 3 patches reais do UMK3+ |
| Determinismo e save state | ✅ | `validate:core`: instâncias idênticas, save/load exato |
| **Online entre dois navegadores (localhost e LAN)** | ✅ | E2E com dois Firefox independentes pelo IP da rede (HTTPS), em P2P e em relay: o Player 2 entra no jogo em andamento do Player 1 em ~2 s, sem Enter; P2 com as mesmas teclas; sem dessincronia |
| Signaling (Spring Boot) | ✅ | 11 testes JUnit, incluindo servidor e clientes WebSocket reais |
| Matchmaking, contas, rankings, STUN/TURN (internet) | ⏳ próximas fases | ver [docs/architecture.md](docs/architecture.md#backend-planejado) |

## Requisitos

- Node.js ≥ 22.12 (testado com 26.13) e npm
- Java 21 (o Maven 3.9.16 é baixado pelo wrapper `apps/api/mvnw`)
- Para compilar o core: `meson`, `ninja`, `perl`, compilador C/C++ nativo. O Emscripten 7.0.0 é instalado pelo script.
- Navegador com OffscreenCanvas, AudioWorklet e WebRTC (Chrome/Edge, Firefox 105+, Safari 16.4+)

## Começando

```bash
npm install
./emulator/scripts/setup-emsdk.sh   # uma vez
npm run build:wasm                  # gera o core em apps/web/public/emulator
npm run dev:api                     # terminal 1: signaling em http://localhost:8080
npm run dev                         # terminal 2: http://localhost:5173
```

Coloque as ROMs em `data/roms/`: `umk3.zip` (rev 1.2) junto com `umk3p.zip` (set split FBNeo/MAME), **ou**
`umk3.zip` junto com o zip do patch oficial do UMK3 Plus. Ao abrir a página, o jogo carrega e inicia sozinho
(offline, você como Player 1). O som liga no primeiro clique ou tecla (exigência dos navegadores).

**Tela cheia:** botão ⛶ no canto da tela do jogo, botão "Tela cheia" na barra ou duplo clique no jogo; Esc sai.
O jogo mantém a proporção 4:3 sobre fundo preto, e as notificações aparecem sobre o jogo por alguns segundos.

**CMOS (configurações da máquina):** o jogo usa, nesta ordem: **as suas configurações salvas neste navegador** →
`data/nvram/umk3p.fs` (dump cru de 32 KiB da NVRAM, o `.fs` que o FBNeo/MAME gravam) → CMOS de fábrica. O painel
"Estado" mostra qual está em uso e quando foi salva pela última vez.

- **Alterar:** **F2** (ou o botão "Menu de teste") abre o menu de teste da placa, com **UMK3+ SETTINGS**, ajustes,
  auditorias etc. Só offline: no online, o switch dessincronizaria a partida.
- **Salvar:** a cada ~2 s, se a CMOS mudou (configurações, mas também contadores de fichas, recordes e o contador de
  ligações do próprio boot), ela é gravada no `localStorage` **deste navegador**. Cookies não servem para isso: a CMOS
  tem 32 KiB (cookies têm ~4 KiB) e cookies são enviados ao servidor em toda requisição. O `localStorage` fica só na
  máquina, por navegador/perfil, e nunca é enviado.
- **Só para você:** no online, o Player 2 joga na máquina do Player 1 (com a CMOS do Player 1), mas nada disso é
  gravado no navegador do Player 2, nem se ele continuar sozinho depois que o Player 1 sair. Ao recarregar, ele volta
  para a própria CMOS. O reinício por Enter também usa a máquina (e a CMOS) do Player 1.
- **Desfazer:** "Apagar minhas configurações", no painel Estado, apaga a CMOS salva e recarrega a página.

O `umk3p.fs` é servido em `/nvram/` (outra pasta via `UMK3_NVRAM_DIR`), também
para o outro computador no modo LAN.

ROMs e NVRAM são servidas **só pelo servidor local do Vite** (`npm run dev` / `npm run preview`, plugin
`apps/web/vite-plugin-local-data.ts`; outra pasta de ROMs via `UMK3_ROM_DIR`). Nada disso entra no build de
produção (`dist/`) nem no git (`data/` é ignorada). Detalhes e hashes em [docs/roms.md](docs/roms.md).
**Nunca versione ROMs.**

## Jogar online

1. Abra a página em um navegador: você é o **Player 1** e o jogo já começa (você pode jogar sozinho).
2. Abra o mesmo endereço em outro navegador ou computador: ele é o **Player 2** e **entra direto no jogo em andamento
   do Player 1** (~2 s), sem apertar nada. A partir daí os dois jogam sincronizados.
3. Opcional: **Enter** nos dois reinicia o jogo do zero.

Use `?room=nome` no endereço para salas separadas (sem `?room=`, a sala é `local`).

Regras da sala (aplicadas pelo servidor): o primeiro a entrar é o Player 1 e o segundo, o Player 2. Se o Player 1
sair, o jogo continua rodando para o Player 2, que vira Player 1; quem entrar depois é o Player 2 e entra nesse jogo.
Um terceiro é recusado (continua offline). Se os dois jogos divergirem, o Player 1 reenvia o estado automaticamente.
A página avisa entrada e saída de jogadores, sincronização, pedidos de reinício, o tipo de conexão (P2P ou relay) e
dessincronizações. O painel "Online" mostra seu papel, a latência (RTT) e o input delay.

### Na mesma máquina (dois navegadores)

```bash
npm run dev:api   # terminal 1
npm run dev       # terminal 2 -> http://localhost:5173 nos dois navegadores
```

### Em LAN (dois computadores na mesma rede)

No computador que tem as ROMs em `data/roms/`:

```bash
npm run dev:api   # terminal 1
npm run dev:lan   # terminal 2: HTTPS em todas as interfaces; mostra "Network: https://<ip>:5173/"
```

Os dois computadores abrem `https://<ip-desse-computador>:5173/` (o próprio host também pode usar esse endereço).

- **Certificado:** o modo LAN usa um certificado autoassinado, e o navegador mostra um aviso na primeira vez
  (Firefox: "Avançado → Aceitar o risco"; Chrome: "Avançado → Continuar"). HTTPS é necessário porque, fora de
  `localhost`, o navegador só libera o áudio (AudioWorklet) em contexto seguro. Por HTTP o jogo funcionaria mudo.
- **Firewall:** a porta **5173/TCP** precisa aceitar conexões da rede no computador host (com ufw:
  `sudo ufw allow 5173/tcp`). A 8080 não precisa: o Vite repassa `/ws` internamente para o backend.
- **ROMs:** o outro computador baixa as ROMs do host pela rede (`/roms/`) e emula localmente; ele não precisa tê-las.
- O servidor aceita origens `localhost` e de IPs privados (192.168.x.x, 10.x.x.x, 172.x.x.x, `*.local`); configure em
  `apps/api/src/main/resources/application.yml`.

Controles (iguais para quem é Player 1 ou Player 2, cada um no próprio teclado; reconfiguráveis e salvos no navegador):

| Ação | Tecla |
|---|---|
| Direcionais | W A S D |
| Soco alto / Bloqueio / Chute alto | U / I / O |
| Soco baixo / Correr / Chute baixo | J / K / L |
| Start / Ficha | 1 / 5 |
| Reiniciar do zero (online: os dois apertam) | Enter (reservado) |
| Menu de teste da placa (só offline) | F2 (reservado) |

Com a CMOS de fábrica, uma ficha não basta para começar: insira mais até aparecer "PRESS START" (com o
`umk3p.fs`, vale a configuração gravada nele).
Na tela de modo, o **Start** confirma.

## Scripts

| Comando | Descrição |
|---|---|
| `npm run build:wasm` | compila o core FBNeo para WASM |
| `npm run dev` | servidor de desenvolvimento Vite em `http://localhost:5173` (proxy de `/ws` para a API) |
| `npm run dev:lan` | o mesmo, em HTTPS e acessível pela rede local |
| `npm run dev:api` | backend Spring Boot (signaling) na porta 8080 |
| `npm run build` | typecheck + build de produção em `apps/web/dist` |
| `npm run typecheck` | TypeScript (UI, worker, worklet, testes e protocolo) |
| `npm test` | testes do web e do protocolo (os de gameplay pulam sem ROMs) |
| `npm run test:api` | testes do backend (JUnit) |

## Validar com suas ROMs

```bash
npm run validate:core -w @umk3/web            # usa data/roms/
UMK3_ROM_DIR=/outro/dir npm run validate:core -w @umk3/web
```

Roda o core real em Node: boot, frames, áudio, desempenho, determinismo, save state, boot sem tela de CMOS e
uma partida online simulada (dois cores em lockstep sobre uma rede com 25% de perda, comparando hashes do estado) e
a entrada no meio do jogo (estado de um core transferido como na rede e continuado identicamente por outro).

## Documentação

- [docs/architecture.md](docs/architecture.md): fluxo, API do core, netplay, estrutura, backend
- [docs/roms.md](docs/roms.md): ROM set, hashes, processo de patch, licenciamento
- [emulator/README.md](emulator/README.md): build WASM
- ADRs: [0001 FBNeo + frontend próprio](docs/adr/0001-emulator-fbneo-custom-wasm-frontend.md) ·
  [0002 Worker/OffscreenCanvas/AudioWorklet](docs/adr/0002-worker-offscreencanvas-audioworklet.md) ·
  [0003 ROMs no navegador](docs/adr/0003-rom-verification-in-browser.md) ·
  [0004 Determinismo/netcode](docs/adr/0004-determinism-for-delay-based-netcode.md) ·
  [0005 Backend](docs/adr/0005-backend-deferred.md) ·
  [0006 Netplay: salas, lockstep e transporte](docs/adr/0006-netplay-rooms-lockstep-transport.md)

## Limitações conhecidas

- **LAN testada só com os dois navegadores neste computador**, acessando pelo IP da rede (`https://192.168.0.107:5173`):
  isso cobre a interface de rede, o HTTPS e a checagem de origem, mas não um segundo computador físico. Entre
  computadores, se o WebRTC não conectar (descoberta mDNS, firewall), o relay pelo servidor assume sozinho.
- Pela internet (redes diferentes) falta STUN/TURN (coturn) para o P2P; o relay exige o servidor acessível aos dois.
- Testado entre duas instâncias do Firefox (perfis separados). Chrome e Safari não foram testados nesta máquina.
- Ao entrar, o Player 2 substitui o jogo dele pelo do Player 1. O jogo do Player 1 para por uma fração de segundo
  enquanto o estado (~70–210 KB comprimido) é enviado e carregado; no E2E, foram 5 ticks de espera.
- Sem autenticação: qualquer um que souber o nome da sala entra nela.
- Sem rollback: com latência alta, o input delay cresce (até 8 frames) e o jogo espera pelo adversário quando
  falta input.
- Pausar, avançar frame, reset e save/load ficam desativados durante a partida online (dessincronizariam).
- A CMOS salva fica no navegador, não no `data/nvram/umk3p.fs`, que nunca é alterado. Limpar os dados do site no
  navegador apaga as suas configurações.
- Durante uma partida online valem as configurações do Player 1 (ex.: as opções do UMK3+ dele), para os dois.
- Tela cheia não pôde ser exercida de fato no teste automatizado: o Firefox headless nega qualquer pedido de tela
  cheia. Foi verificado que os três controles pedem tela cheia do elemento certo.
- O UMK3 roda a **54,71 Hz**. Pequenos *clicks* de áudio podem ocorrer quando o worker atrasa ou espera o adversário.
- O build de produção (`dist/`) sozinho não tem ROMs; hospedá-lo exige outra forma de o usuário fornecê-las.
- Sem suporte a gamepad ainda (só teclado).
- Licença do FBNeo: **uso não comercial**. Proíbe lucro e pedido de doações e exige publicar modificações (ver ADR-0001).

## Próximos passos

1. coturn (STUN/TURN) e configuração de `iceServers` para jogar entre redes diferentes; testar no Chrome.
2. Autenticação (Spring Security) e salas privadas com convite; histórico de partidas (PostgreSQL).
3. Exportar/importar a CMOS salva como arquivo `.fs` (para levar as configurações a outro navegador).
4. Gamepad API no `InputManager`.
5. Avaliar rollback netcode sobre o save state já existente (2,4 MB, ~1,7 ms para salvar e calcular o hash).
