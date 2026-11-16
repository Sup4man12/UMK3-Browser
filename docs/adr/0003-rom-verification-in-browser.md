# ADR-0003: ROMs fornecidas pelo usuário, verificadas por CRC e patcheadas no navegador

- Status: aceito
- Data: 2026-11-13

## Contexto

O UMK3 Plus exige o set `umk3` rev 1.2 com 3 chips patcheados por IPS mais 4 ROMs gráficas novas
(detalhes em [docs/roms.md](../roms.md)). Não podemos distribuir ROMs, e o processo manual com Lunar IPS,
renomeação e rezip é fonte comum de erro, o que se vê nos fóruns.

## Decisão

- O core expõe a lista de ROMs do driver (nome, tamanho, CRC, flags). É a **única fonte de verdade**; o
  TypeScript não duplica a tabela do driver.
- A correspondência é feita por **CRC-32 + tamanho**, nunca por nome de arquivo.
- Slots faltantes são derivados aplicando cada IPS fornecido a cada candidato. O resultado só é aceito com
  o CRC final exato. Aplicar um patch à base errada, portanto, nunca passa despercebido.
- O motor de IPS embutido no FBNeo fica desativado (`bDoIpsPatch = false`), porque depende do sistema de
  arquivos e da UI do burner.
- A verificação e o patch rodam no worker; o servidor só entrega os arquivos de `data/roms/`, sem processá-los.

## Consequências

- `data/roms/` pode ter `umk3.zip` + `umk3p.zip` ou `umk3.zip` mais o zip oficial do patch, sem preparo manual.
- (Revisão de 2026-11-13) O seletor de arquivos foi removido: o worker baixa as ROMs de `/roms/`, servidas a partir de
  `data/roms/` só pelos servidores locais do Vite. O build de produção não inclui ROMs.
- O custo de busca é O(patches × arquivos) aplicações IPS + CRC. Com 3 patches e ~30 arquivos de até 1 MiB, é
  aceitável, mas deve ser medido com ROMs reais.
- Uma implantação pública vai precisar de outra forma de o usuário fornecer as ROMs (por exemplo, voltar a um
  seletor e persistir o set verificado no IndexedDB).
