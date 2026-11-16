# ADR-0006: Netplay: salas no servidor, lockstep no worker, WebRTC com relay de reserva

- Status: aceito; revisado em 2026-11-15 (entrada no jogo em andamento, LAN)
- Data: 2026-11-14

## Contexto

Dois jogadores, cada um com sua instância determinística do core ([ADR-0004](0004-determinism-for-delay-based-netcode.md)).
Requisitos da fase: notificações na página (entradas, saídas, prontos), o segundo a entrar é sempre o Player 2,
os dois usam o mesmo mapeamento de teclado, Enter dos dois para começar ou reiniciar, e funcionar em localhost
entre dois navegadores.

## Decisões

### Salas: autoridade no servidor (`apps/api`, módulo `signaling`)

- `Room` é uma máquina de estados pura (cada operação devolve as mensagens a entregar), testada sem rede. O
  `SignalingHandler` só faz o transporte.
- Jogador = posição na ordem de chegada. Se o Player 1 sai, o Player 2 é promovido, então quem entra depois é
  sempre o Player 2. A capacidade é 2; o terceiro recebe `room-full`.
- Prontos: cada Enter alterna o "pronto" do jogador. Com os dois prontos e o mesmo build do core (`hello.build` =
  SHA-256 do `.wasm`), o servidor envia `match-start` com `sessionId` aleatório e o input delay. Os prontos zeram
  em toda entrada, saída e início, então reiniciar exige os dois de novo.
- Input delay = `ceil((pior RTT / 2) / 18,28 ms) + 1`, entre 2 e 8 frames (3 sem medição).
  Em localhost: 2 frames.

### Lockstep: no GameWorker, lógica pura em `Lockstep.ts`

- O input local amostrado antes do frame F vale para o frame F + delay. O frame F só roda com os inputs dos dois.
- Pacotes não confiáveis e sem ordem: cada pacote reenvia todos os inputs que o adversário ainda não confirmou
  (até 64) e confirma os dele. Perdas se resolvem no pacote seguinte, sem retransmissão. Enquanto espera, o
  worker repete o pacote a cada tick.
- Quem ficou para trás roda um frame extra por tick para alcançar.
- Os dois partem do mesmo snapshot (estado logo após o primeiro boot da CMOS) com reset, qualquer que seja o
  estado offline anterior.
- A cada 120 frames, os dois trocam o hash do estado completo; divergência gera a notificação de dessincronia.
- Pausar, avançar, reset e save/load são recusados durante a partida.

### Transporte: WebRTC DataChannel, com relay pelo WebSocket de signaling

- DataChannel `ordered: false, maxRetransmits: 0`. O Player 1 cria a oferta; o Player 2 cria um link passivo
  assim que vê o adversário.
- Se o DataChannel não abrir em 5 s (ou se o navegador não tiver WebRTC), os pacotes passam como frames binários
  pelo WebSocket de signaling, e o servidor os repassa sem interpretar (máx. 1 KiB). Cada lado escolhe o caminho
  sozinho e aceita os dois, então não há negociação.
- Ping/pong pelo mesmo caminho dos inputs mede o RTT mostrado na UI e usado no cálculo do delay.

## Alternativas

- **Rollback:** melhor sensação com latência alta, mas exige re-simular vários frames por tick (~2–3 ms cada) e
  render desacoplado. Fica para depois; o save state rápido já existe.
- **Só WebRTC:** em localhost entre navegadores diferentes, a ofuscação de IPs por mDNS e a ausência de loopback nos
  candidatos podem impedir a conexão. O relay garante que a sessão funcione, com latência maior.
- **Lockstep na thread principal:** evitaria o salto worker→main, mas colocaria o relógio do jogo à mercê do React
  e da coleta de lixo da UI.

## Validação (2026-11-14)

- `Lockstep.test.ts`: dois pares simulados com até 60% de perda e reordenação veem inputs idênticos em 2000 frames.
- `core.integration.test.ts`: dois cores reais em lockstep (25% de perda; um deles jogou offline antes) têm os
  12 hashes de estado iguais em 1500 frames.
- E2E com dois Firefox headless independentes, em P2P e com WebRTC desligado em um deles (relay): P1/P2 por
  ordem de chegada, notificações, Enter dos dois, reinício, promoção do P2 ao sair o P1, nova partida com papéis
  trocados, P2 entrando na seleção de lutadores com as mesmas teclas, sem dessincronia e sem erros de console.

## Consequências

- O delay mínimo de 2 frames (~37 ms) é perceptível, mas justo: os dois sentem o mesmo atraso.
- Partidas pela internet precisam de STUN/TURN (coturn) para P2P; sem isso, o relay depende de o servidor estar
  acessível aos dois.
- Os inputs passam pelo thread principal (DataChannel não existe em workers em todos os navegadores). Travadas
  longas da UI atrasam o envio.

## Revisão de 2026-11-15: entrada no jogo em andamento e LAN

### O Player 2 entra no jogo do Player 1 (sem Enter)

- O Player 1 é sempre a autoridade do estado. Quando o transporte com o Player 2 abre, ele mede o RTT (espera até 1 s
  pela primeira amostra), escolhe o input delay (`inputDelayForRtt`, mesma fórmula do servidor) e envia `HOST_SYNC`
  ao worker. Entre dois ticks (portanto, numa fronteira de frame), o worker salva o estado, envia `sync-begin` mais
  pedaços deflate de até 16 KiB (2,4 MB viram ~70–210 KB) e entra em lockstep no frame 0.
- O Player 2 confere o build (`sync-begin.build`), remonta o estado (`SyncReceiver`: independente da ordem de
  chegada e de duplicatas; verifica o hash) e carrega o jogo no lugar do seu. A partir daí os dois seguem em lockstep.
- **Caminho confiável:** um 2º DataChannel `sync` (ordenado, confiável). O transporte só é "p2p" com os dois canais
  abertos; sem eles, o relay do WebSocket (também confiável). O servidor aceita frames binários até 16 KiB + cabeçalho.
- Um reset pendente fica fora do save state. Os dois lados aplicam-no antes de salvar ou carregar.
- **Dessincronia:** o Player 1 reenvia o estado com uma nova sessão (ressincroniza automaticamente).
- **Saída de um jogador:** o lockstep acaba, mas o jogo de quem ficou continua rodando; quem entrar depois entra nele.
- **Enter:** os dois juntos reiniciam do zero (fluxo `ready`/`match-start` original, agora opcional). Revisão de
  2026-11-16: como cada jogador tem a própria CMOS (salva no navegador), só o Player 1 reinicia, com a CMOS dele, e
  envia a máquina pelo mesmo caminho do sync; dois reinícios independentes partiriam de CMOS diferentes. A CMOS
  recebida pelo Player 2 nunca é gravada no navegador dele.

Validação: `core.integration.test.ts` transfere o estado de um core que jogou 1500 frames para um core novo pelo
caminho real (`packState` → bytes → `SyncReceiver`), e os dois seguem idênticos por 1200 frames (imagem e estado).
No E2E, o Player 2 sincronizou em 2,1–2,7 s depois de abrir a página, em P2P e em relay.

### LAN

- `npm run dev:lan`: o Vite escuta em todas as interfaces com HTTPS autoassinado (`@vitejs/plugin-basic-ssl`).
  Fora de `localhost`, AudioWorklet só existe em contexto seguro; por HTTP o jogo ficaria mudo.
- `/ws` é repassado pelo próprio Vite para o backend, então só a porta 5173 precisa estar aberta.
- O backend aceita padrões de origem de rede privada (`allowed-origin-patterns`) e recusa origens públicas (testado).
- O servidor agora aplica limites por sessão WebSocket (texto 64 KiB, binário 16 KiB + 64). O
  `ServletServerContainerFactoryBean` usado antes não tinha efeito no Spring Boot 4, e o limite efetivo era 8 KiB,
  descoberto pelo teste de relay de 16 KiB.
- Se o adversário fala pelo relay, o link troca para relay na hora em vez de esperar o timeout de 5 s do WebRTC
  (a entrada com o relay caiu de 8 s para 2 s).

