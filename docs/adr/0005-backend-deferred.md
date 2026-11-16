# ADR-0005: Backend Spring Boot adiado; estrutura apenas documentada

- Status: substituído em parte (2026-11-14): o módulo `signaling` foi implementado ([ADR-0006](0006-netplay-rooms-lockstep-transport.md)). Infra/Docker continuam adiados.
- Data: 2026-11-13

## Contexto

O objetivo desta fase é provar que o UMK3 Plus roda no navegador. Nenhuma funcionalidade da prova de conceito
depende de servidor: as ROMs ficam no cliente e não há multiplayer ainda. A máquina de desenvolvimento usada
não tem Maven nem Docker para validar um build Java ou um `docker-compose`.

## Decisão

Não criar `apps/api`, `docker-compose.yml`, `infra/` (Nginx, coturn, PostgreSQL, Redis) nem `.env.example`
nesta fase. Criar esqueletos sem conseguir compilá-los ou subi-los violaria a regra de não entregar nada
sem evidência de funcionamento. O desenho previsto está em [docs/architecture.md](../architecture.md#backend-planejado).

## Consequências

- O app web é estático: `vite build` gera `apps/web/dist`, servível por qualquer servidor HTTP (ou pelo Nginx
  no futuro). Requisitos: servir `.wasm` como `application/wasm` e `.mjs` como JavaScript.
- A próxima fase começa pelo módulo `signaling`, o primeiro com valor real para o multiplayer.
