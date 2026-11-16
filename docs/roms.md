# ROMs: Ultimate Mortal Kombat 3 Plus

O projeto **não distribui ROMs** e nunca deve versioná-las (`.gitignore` bloqueia `*.zip`, `*.bin`, `*.ips`, `roms/`).
Os zips ficam em `data/roms/` (ignorado pelo git). O servidor local do Vite os entrega em `/roms/` e o Web Worker
os baixa, verifica e processa ao abrir a página. Eles nunca são copiados para o build de produção.

## O que é o UMK3 Plus

UMK3 Plus (UMK3+) é um **hack de fãs** do arcade *Ultimate Mortal Kombat 3*, feito pela "Team Plus"
(TehDrewsus e ZPaul2Fresh8). A versão suportada é a **Public Beta 2** (2022). Não é um lançamento oficial da Midway.

- Página dos autores: <https://www.zpaul2fresh8.com/game-hacks/mk> (o pacote de patch e o changelog ficam no Google Drive).
- O FBNeo já tem o driver `umk3p` ("Ultimate Mortal Kombat 3 Plus (Hack, Beta 2)", `src/burn/drv/midway/d_wunit.cpp`),
  marcado como `BDF_GAME_WORKING | BDF_HACK`, clone de `umk3`. **Não foi necessário alterar o driver.**

## Estrutura do ROM set `umk3p` (Midway Wolf-unit)

| Região | Chips | Origem |
|---|---|---|
| Programa TMS34010 | u54, u63 (512 KiB cada) | `umk3` rev 1.2 **+ patch IPS** |
| Som DCS (ADSP-2105) | u2 (1 MiB) | `umk3` u2 **+ patch IPS** |
| Som DCS | u3, u4, u5 (1 MiB cada) | `umk3`, sem alteração |
| Gráficos | u133–u118, u113–u110 (1 MiB cada) | `umk3`, sem alteração |
| Gráficos **novos** | u117, u116, u115, u114 (512 KiB cada) | pacote do UMK3+ (não existem no `umk3`) |
| PIC de proteção | u64 (`463_mk3_ultimate.u64`) | opcional (`BRF_OPT`), o driver não o carrega |

### Hashes esperados (CRC-32, conforme o driver FBNeo `2c6dac37`)

Arquivos gerados por patch:

| Arquivo `umk3p` | CRC-32 | Base `umk3` (rev 1.2) | CRC-32 da base |
|---|---|---|---|
| `u54_umk3plus.u54` | `54a5359f` | `l1.2_mortal_kombat_3_u54_ultimate.u54` | `712b4db6` |
| `u63_umk3plus.u63` | `fb83320d` | `l1.2_mortal_kombat_3_u63_ultimate.u63` | `6d301faf` |
| `l2.0_mortal_kombat_3_u2_umk3plus.u2` | `2c7f4a1d` | `l2.0_mortal_kombat_3_u2_ultimate.u2` | `3838cfe5` |

ROMs gráficas novas (incluídas no pacote dos autores, com os nomes `umk-u114.bin` … `umk-u117.bin`):

| Arquivo | CRC-32 | SHA-1 |
|---|---|---|
| `umk3p-u117.bin` | `52ee547e` | `97dba4d6dd503a623dad5709767e4617de211af0` |
| `umk3p-u116.bin` | `f6df5c98` | `e8317cf46d23738223f034c10f0f6f874d72165f` |
| `umk3p-u115.bin` | `e003a51b` | `e11c0cb0a9d647f17398b48d0b7d088526a18af8` |
| `umk3p-u114.bin` | `b8504598` | `fce32581d6ff9e1a7455c30fb10812ba9dc70db5` |

Patches IPS do pacote oficial (zip de 2022-03, 1.004 KiB):

| Arquivo | CRC-32 | SHA-1 |
|---|---|---|
| `l1.2_mortal_kombat_3_u54_ultimate.ips` | `478f0a68` | `12c336ac76e509fdca408d0e6ba57f7073077b6f` |
| `l1.2_mortal_kombat_3_u63_ultimate.ips` | `d6557ca9` | `1d1895c23904a20faaf7f0079c952c80eb5b77ab` |
| `l2.0_mortal_kombat_3_u2_umk3plus.ips` | `8a3de626` | `de4580c09491a5a5f59a0e0accb799500adc9123` |

Os demais 23 arquivos são idênticos aos do `umk3`; a lista completa com CRCs é exibida pela própria aplicação
e verificada em `apps/web/tests/core.integration.test.ts`.

## Como o app monta o set (`apps/web/src/game/rom/romset.ts`)

`data/roms/` pode conter, em qualquer combinação:

- o set split FBNeo/MAME: `umk3.zip` + `umk3p.zip` (o clone contém só os 7 arquivos alterados/novos), **ou**
- o `umk3.zip` (rev 1.2) **mais** o zip do pacote de patch do UMK3+, sem descompactar nada.

O processo:

1. Arquivos `.zip` são extraídos em memória (`fflate`); os demais são usados como estão.
2. Cada arquivo é identificado por **CRC-32 + tamanho**, nunca pelo nome: MAME, FBNeo e o pacote do UMK3+
   dão nomes diferentes aos mesmos chips.
3. Para cada ROM obrigatória sem correspondência direta, cada patch IPS fornecido é aplicado a cada arquivo
   candidato. O resultado só é aceito se o **CRC-32 do arquivo final for exatamente o esperado pelo driver**.
   Assim, o app não precisa fixar qual patch pertence a qual chip, e uma base errada nunca é aceita.
4. Só com o set completo e verificado as ROMs são copiadas para a memória do WASM.

O formato IPS é aplicado por registro (offset de 24 bits, tamanho de 16 bits, registros RLE e a extensão
de truncamento do Lunar IPS), e **não** por concatenação de arquivos. O parser foi validado contra os três
patches reais do pacote: todos são lidos sem erro e geram arquivos com o tamanho exato esperado pelo driver.

## Licenciamento (não é aconselhamento jurídico)

- As ROMs do *Ultimate Mortal Kombat 3* são propriedade intelectual da Warner Bros. / Midway. Possuir a placa
  original não autoriza automaticamente a distribuição das imagens. O projeto não as hospeda nem as distribui.
- As ROMs gráficas novas e os patches são obra dos autores do UMK3+ sobre esse material. O site dos autores
  pede que não sejam solicitadas ROMs. Este projeto não redistribui o pacote; o usuário o obtém na fonte oficial.
- O backend futuro **não deve** receber, armazenar nem trafegar ROMs. No multiplayer, cada cliente valida
  localmente e troca apenas um identificador (por exemplo, hash do set montado) para confirmar compatibilidade.
