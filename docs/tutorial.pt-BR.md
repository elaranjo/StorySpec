# Sua primeira mudança literária

Este tutorial usa apenas arquivos locais. Os quatro [exemplos completos](../examples/README.md) contêm os artefatos finais em inglês e português.

1. Instale pelo repositório e inicie um projeto: `npm install -g git+https://github.com/elaranjo/StorySpec.git`, depois `mkdir minha-historia && cd minha-historia && storyspec init "Minha história" --lang pt-BR --profile novel`.
2. Crie o plano: `storyspec new chapter abertura`, `storyspec new scene abertura escolha` e `storyspec new delta abertura trama`. Preencha `proposal.md`, `design.md`, `chapter-contract.md` e `scenes/escolha.md` em `storyspec/changes/abertura/`. Mantenha os títulos gerados, substitua os marcadores e cite um caminho real do projeto nas listas obrigatórias de fontes. Preencha o delta com um requisito `ADDED`. O [exemplo Novel em português](../examples/novel-pt/) mostra todos os arquivos.
3. Execute `storyspec next abertura`, `storyspec validate abertura` e `storyspec approve abertura plan --author "Seu nome"`. A aprovação vincula os arquivos e fontes consultados.
4. Escreva `manuscript/abertura.md` no seu editor e aceite com `storyspec manuscript accept abertura manuscript/abertura.md --author "Seu nome"`. A CLI registra o hash e não edita a prosa.
5. Descreva a cena: `storyspec map scene set abertura escolha --order 1 --origin "A história começa"`. Para um requisito `trama/escolha-custosa`, execute `storyspec map coverage set abertura trama/escolha-custosa --status realized` e `storyspec map passage add abertura trama/escolha-custosa --scene escolha --lines 3:3`. O comando lê o caminho e o hash do manuscrito aceito. Use `partial --target <capitulo-futuro> --reason <porquê>` quando a cobertura é incompleta, ou `deferred` com justificativa quando ainda não há realização no manuscrito.
6. Execute `storyspec verify abertura --json`. Corrija erros de arquivo e hash. Para justificar um achado narrativo dispensável, use `storyspec map waive abertura <id-do-achado> --author "Seu nome" --reason "Justificativa"`. Depois execute `storyspec verify abertura --record`.
7. Marque as tarefas em `tasks.md`. Gere `storyspec review abertura dramaturgy`, edite o JSON e registre com `storyspec review abertura dramaturgy --record --author "Revisora"`. Repita para `continuity` e `prose`. O parecer de dramaturgia precisa de uma entrada `requirementAssessments` para cada requisito realizado ou parcial: `{"domain":"trama","requirement":"escolha-custosa","verdict":"SATISFIED","rationale":"A decisão citada tem consequência visível."}`. Uma pessoa precisa fazer esse julgamento.
8. Execute `storyspec approve abertura final --author "Seu nome"`, `storyspec apply abertura --dry-run`, `storyspec apply abertura` e `storyspec archive abertura`. Consulte o histórico com `storyspec history abertura`.

Use `storyspec status abertura --json` a qualquer momento para ver artefatos e pendências. Após alterar plano, fonte, parecer, manuscrito aceito ou estado narrativo paralelo, execute `storyspec reconcile abertura --json`. A pessoa responsável precisa registrar novamente qualquer aprovação invalidada.

## Instruções opcionais para assistentes

`storyspec adapters install codex --dry-run` mostra a integração local antes da instalação. Troque `codex` por `claude` ou `cursor`; retire `--dry-run` para instalar. Os três adaptadores seguem o mesmo [contrato para assistentes](assistant-contract.md). A CLI e as decisões humanas funcionam sem assistente.
