# StorySpec

O StorySpec é um framework local de especificações narrativas para Novels e Light Novels, independente de editor e fornecedor de IA. Não inclui universo ficcional, serviço remoto ou agente obrigatório. Requer Node.js 20 ou superior. [Read in English](README.md).

## Instalação e início

```sh
npm install -g git+https://github.com/elaranjo/StorySpec.git
mkdir minha-novel && cd minha-novel
storyspec init "Minha novel" --lang pt-BR --profile novel
```

O idioma padrão é inglês. Os perfis `generic`, `novel` e `light-novel` usam o mesmo fluxo. O perfil Light Novel acrescenta campos opcionais de ritmo por volume, momentos visuais e possíveis ilustrações, sem impor extensão. Idioma e perfil ficam em `storyspec/config.json`. `storyspec help --lang pt-BR` lista os comandos.

## Ciclo de mudança narrativa

**Propor → especificar → planejar → escrever → aceitar manuscrito → verificar → revisar → aprovar → aplicar → arquivar.** Tudo funciona com arquivos locais e revisão humana, mesmo sem IA. `storyspec status <id> --json` mostra artefatos, pendências e próxima ação; `storyspec next <id>` mostra o próximo comando e caminho sem editar o conteúdo.

```sh
storyspec new chapter capitulo-um
storyspec new scene capitulo-um abertura
storyspec new delta capitulo-um trama
```

Preencha `proposal.md`, `design.md`, `chapter-contract.md`, a cena e o delta em `storyspec/changes/capitulo-um/`. Nas listas opcionais `Fontes` da proposta e do plano, cite caminhos Markdown relativos ao projeto que fundamentam as decisões. Os campos obrigatórios de contrato e cena são configuráveis em `storyspec/config.json`. Depois:

```sh
storyspec validate capitulo-um
storyspec approve capitulo-um plan --author "Autora"
storyspec context capitulo-um --scene abertura --purpose write
```

A aprovação do plano é obrigatória antes de gerar contexto para escrita. Escreva em `draft.md` ou no editor de sua preferência. Marque as tarefas concluídas e use os comandos `storyspec map` para vincular requisitos, cenas e passagens aceitas. Aceite o manuscrito, registre a verificação narrativa e depois preencha e registre os pareceres humanos:

```sh
storyspec manuscript accept capitulo-um manuscript/capitulo-um.md --author "Autora"
storyspec map scene set capitulo-um abertura --order 1 --origin "A escolha inicial"
storyspec map coverage set capitulo-um trama/escolha-custosa --status realized
storyspec map passage add capitulo-um trama/escolha-custosa --scene abertura --lines 3:3
storyspec verify capitulo-um --record
storyspec review capitulo-um dramaturgy
storyspec review capitulo-um dramaturgy --record --author "Revisora"
storyspec review capitulo-um continuity
storyspec review capitulo-um continuity --record --author "Revisora"
storyspec review capitulo-um prose
storyspec review capitulo-um prose --record --author "Revisora"
storyspec approve capitulo-um final --author "Autora"
```

O JSON de cada revisão exige `verdict` (`PASS` ou `BLOCK`), `summary`, uma lista não vazia de caminhos em `evidence`, `findings` e `waivers`. Cada achado tem ID, gravidade `BLOCKER` ou `NOTE` e texto. Um achado bloqueante exige dispensa com ID, nome declarado do autor e justificativa antes da aprovação final. O registro da revisão guarda hashes e cópias locais das evidências citadas. IA pode auxiliar, mas não substitui o parecer humano. A CLI valida estrutura e referências; não avalia qualidade literária nem comprova a identidade de quem assinou.

O StorySpec registra caminho e hash SHA-256 do manuscrito, sem editar a prosa. Confira as mudanças controladas, aplique e arquive:

```sh
storyspec apply capitulo-um --dry-run
storyspec apply capitulo-um
storyspec archive capitulo-um
```

`apply` atualiza specs, claims e o índice narrativo na mesma transação. Se a aplicação parar, fica um registro de transação: `storyspec apply --recover capitulo-um` restaura os arquivos anteriores ou conclui o registro quando o estado já foi gravado. `archive` marca a mudança como `ARCHIVED` no diretório original `storyspec/changes/capitulo-um/` após aplicação e aceite do manuscrito; os caminhos citados continuam válidos. `storyspec history capitulo-um` localiza mudanças atuais e arquivos movidos pela versão 0.6. A distribuição pública é descrita abaixo.

Para mudança sem manuscrito, use `storyspec new change regra-de-viagem --type world` (também `character` ou `plot`) e crie um delta. São obrigatórios os pareceres de dramaturgia e continuidade, sem aceite de manuscrito. Mudanças do tipo `revision` exigem aceite e os três pareceres.

## Mapa narrativo e verificação

Novas mudanças têm `narrative-map.json` (fluxo versão 3, mapa versão 2). Cada requisito `ADDED` ou `MODIFIED` exige uma entrada em `coverage`. `deferred` exige `defer.target` e `defer.reason`; `partial` exige esses campos, cena e passagem do manuscrito aceito; `realized` exige cena e passagem. Cada entrada `links` do mapa versão 2 une uma cena a uma passagem aceita. A passagem registra `path`, `hash` do manuscrito aceito, `startLine` e `endLine` (linhas começando em 1). Mudanças sem manuscrito usam adiamento justificado. `storyspec verify <id> --json` relata cobertura e continuidade; `--record` guarda o relatório para a aprovação final.

Cada cena tem ID local à mudança, `narrativeOrder` único, arrays `storyAfter` e `causedBy` com chaves como `capitulo-um/abertura`, `originReason` opcional, `stateChanges` e `knowledgeChanges`. `storyAfter` define a ordem dos acontecimentos independentemente da apresentação. Uma transição de estado usa `{ "entity": "storyspec/characters/heroina.md", "field": "location", "from": "casa", "to": "estrada" }`; uma de conhecimento usa `{ "character": "heroina", "claim": "storyspec/claims/fact/segredo.md", "from": "UNAWARE", "to": "KNOWS" }`. O índice aplicado fica em `storyspec/narrative-state.json`. Achados narrativos dispensáveis podem entrar em `waivers` com `issueId`, `author` e `reason`. Erros de arquivo, referência e hash não aceitam dispensa. Os pareceres humanos continuam responsáveis por dramaturgia e prosa. O parecer de dramaturgia deve avaliar cada requisito realizado ou parcial com um veredito justificado em `requirementAssessments`.

Mudanças anteriores preservam o fluxo original. `storyspec map init <id>` ativa o mapa versão 1 em mudanças antigas sem mapa; `storyspec map upgrade <id>` atualiza mapas ativos quando o vínculo entre cena e passagem é inequívoco. As aprovações afetadas são invalidadas sem reescrever documentos narrativos.


## Escrita guiada e assistentes

`storyspec/schema.json` define dependências, modelos e condições de conclusão dos artefatos. Novel e Light Novel são presets. O projeto pode acrescentar artefatos Markdown em `extras/` para o plano ou a etapa final; execute `storyspec schema validate` após editar o esquema. Os hashes das aprovações incluem o esquema e os artefatos personalizados aplicáveis. `storyspec reconcile <id> --json` explica decisões invalidadas por edições ou mudanças paralelas.

O [tutorial passo a passo](docs/tutorial.pt-BR.md) e [quatro exemplos completos](examples/README.md) cobrem os dois perfis em EN/PT. O uso de assistentes é opcional: `storyspec adapters install codex|claude|cursor --dry-run` mostra as instruções locais; retire `--dry-run` para instalar. Os três seguem o mesmo [contrato para assistentes](docs/assistant-contract.md).

## Specs e claims

Requisitos narrativos vigentes ficam em `storyspec/specs/<domínio>/spec.md`. Uma mudança propõe seções `ADDED`, `MODIFIED` e `REMOVED` em `storyspec/changes/<id>/specs/<domínio>/spec.md`. Esses marcadores e nomes de campos são iguais nos dois idiomas; o texto narrativo pode estar em português ou inglês. Cada requisito contém ID estável, escopo, estado (`CANON`, `PLANNED` ou `OPEN`), enunciado, condição de verificação e referências opcionais a fontes e claims. `MODIFIED` traz o substituto completo; `REMOVED` traz ID e razão. O requisito aplicado registra `Origin: <id-da-mudança>`.

```md
# Delta: trama

## ADDED

### Requirement: escolha-custosa
Scope: volume
Status: PLANNED
Statement: A escolha da protagonista causa uma perda visível.
Verification: O fim do capítulo mostra a perda.
Sources:
Claims:

## MODIFIED

## REMOVED
```

Claims registram fatos atômicos do universo ou conhecimento de personagens. `storyspec new claim ...` cria um rascunho. Para uma mudança controlada, use `storyspec new claim-delta <mudança> <fact|knowledge|clue|event> <id> --operation ADDED|MODIFIED|REMOVED`; preencha o Markdown proposto, marque a claim a aplicar como `CANON` e cite uma fonte. A spec pode referenciar a claim sem copiar o fato. Fontes Markdown importadas permanecem `UNCLASSIFIED`; importar não canoniza conteúdo.

Aprovações de plano e finais guardam nome declarado, data e hash do conteúdo. O registro do plano lista hashes dos artefatos, das specs e claims afetadas (inclusive arquivos novos ainda ausentes) e das referências estruturadas em `Fontes`, `Sources` e `Claims`. Fontes e evidências são copiadas localmente para `evidence/sha256/`, identificadas pelo hash do conteúdo. Alterar plano, base, fonte, tarefas, revisão, evidência ou rascunho aprovados invalida a etapa correspondente e informa o caminho divergente. Uma mudança em domínio não relacionado mantém o plano válido. `apply` confere os hashes da base controlada e recusa conflitos. Após a aplicação, o histórico usa as cópias preservadas; alterações posteriores nas fontes originais não impedem o arquivo. O registro local é uma trilha de decisões, não verificação de identidade ou controle de acesso.

## Projetos antigos

`storyspec migrate --dry-run` antecipa a migração dos formatos 1–3. `storyspec migrate` atualiza a configuração para o formato 4 e guarda cópia em `storyspec/archive/migrations/`, sem reescrever documentos narrativos. Antes da primeira aplicação controlada, execute `storyspec baseline approve --author "Autora"` para ratificar os registros CANON atuais e seus hashes. A migração não presume aprovações retroativas. Projetos sem idioma configurado continuam em português.

## Distribuição

`npm test` executa os testes locais. `npm pack` gera um pacote instalável; instale-o com `npm install -g git+https://github.com/elaranjo/StorySpec.git/storyspec-0.8.0.tgz`. O pacote é distribuído pelo GitHub; não foi publicado no registro npm. Licença: MIT.
