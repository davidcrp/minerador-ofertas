# Minerador de Ofertas — Ad Library

Extensão Chrome + backend + painel web para minerar ofertas (low ticket) na
Biblioteca de Anúncios do Facebook.

**Painel no ar:** https://minerador-ofertas-umber.vercel.app (acesso com login)

```
extensao/   extensão MV3: login, filtros, coleta automática
backend/    Flask: API da extensão, enriquecimento de destinos, painel web
```

## O que ele entrega por anunciante

| Métrica | Origem |
|---|---|
| Anunciante (nome + page_id) | Ad Library |
| Anúncios ativos | varredura profunda por anunciante (contagem real) ou soma do resultado da busca (parcial) |
| Dias rodando | `start_date` do anúncio mais antigo |
| Variações de criativo | `collation_count` |
| Destino final | `link_url` do anúncio, com redirects resolvidos |
| Gateway / plataforma | fingerprint no destino (host, links de checkout, marcadores no HTML) |
| URL de checkout | link do gateway achado na página |
| Preço | valor mais repetido na página, descartando parcelas |
| Foto do produto | `og:image` do destino (poster do anúncio como reserva) |
| Vídeo do anúncio | copiado da CDN da Meta para o Vercel Blob, toca na capa |
| Copy | maior texto entre os anúncios |
| Score | `anúncios_ativos × (1 + dias/30)` — escala ponderada por durabilidade |

## Subir o backend

O banco é **Postgres (Supabase)** — projeto próprio do minerador — inclusive para rodar local, para ser o mesmo
banco em qualquer lugar. Deploy: veja [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).

```bash
pip install -r minerador/backend/requirements.txt
```

Uma vez só, para criar o esquema e o seu usuário (PowerShell):

```bash
$env:DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require"; $env:MINERADOR_ADMIN_SENHA="suaSenhaForte"; python minerador/backend/setup_db.py
```

Depois, para rodar local:

```bash
$env:DATABASE_URL="postgresql://..."; python minerador/backend/app.py
```

Painel em http://127.0.0.1:5010.

## Instalar a extensão

Antes de recarregar depois de mexer nos scripts:

```bash
cd minerador/extensao && node checar.js
```

Ele confere sintaxe e, principalmente, **colisão de nome no topo** entre
`content.js`, `overlay.js` e `painel.js`: os três rodam no mesmo world e
dividem o escopo global, então um `const` repetido derruba o arquivo seguinte
com SyntaxError — o sintoma é o painel sumir, sem pista da causa.


1. `chrome://extensions` → ativar **Modo do desenvolvedor**
2. **Carregar sem compactação** → escolher a pasta `minerador/extensao`
3. Abrir a extensão, entrar com o mesmo usuário/senha do painel
4. Servidor diferente de localhost: preencher em *Configurações de pesquisa →
   Servidor*; o Chrome vai pedir permissão para aquele host

## Como funciona a coleta

`hook.js` roda no contexto da página (world MAIN) e intercepta as respostas
GraphQL que a própria Biblioteca de Anúncios carrega. `content.js` percorre a
árvore do JSON procurando `ad_archive_id` e faz o scroll de paginação. Nada de
seletor de DOM — mudança de layout da Meta não quebra a coleta.

O `background.js` orquestra:

1. abre a Ad Library com o termo pesquisado — **ou reaproveita a aba aberta**,
   se já for a mesma busca ou se *Usar a busca já aberta* estiver marcado **e o campo de termo estiver vazio** —
termo digitado sempre ganha, senão a opção sequestrava a pesquisa em silêncio. Aba
   nova só quando **nenhuma** aba da Biblioteca está aberta; nesse caso o status
   avisa ("Nenhuma aba da Biblioteca aberta — abrindo uma")
2. coleta até o limite configurado, rolando a página
3. descarta anúncios com menos dias que o filtro
4. (opcional, **desligado por padrão**) para cada anunciante top, abre
   `view_all_page_id` **numa aba de segundo plano** e conta os anúncios ativos de
   verdade; a aba é fechada no fim. A URL dessa aba leva `#mn-contagem`: os
   scripts de página leem a marca e não montam painel nem barra de cópia lá, só
   uma faixa dizendo o que é. Sem isso a aba parecia a extensão "pesquisando
   nomes aleatórios" — o que ela mostra é o nome do anunciante sendo contado
5. envia tudo para `/api/anuncios` e `/api/anunciantes`

Antes, o passo 4 navegava a sua própria aba de anunciante em anunciante — você
via a Biblioteca pulando de anúncio em anúncio enquanto a coleta rodava. A aba
que você está lendo agora só é navegada quando você pede uma busca diferente
da que está aberta.

O backend registra cada `link_url` novo como pendente. Como serverless não
mantém worker em background, o enriquecimento é puxado em lotes: quem chama
`POST /api/enriquecer?limite=8` resolve até 8 destinos (redirects + HTML +
gateway + preço, 6 threads) e recebe quantos faltam. A extensão faz isso logo
depois de enviar, e o painel também, até a fila zerar.

## Fila de termos e tempo de coleta

O botão diz o que vai rodar: com fila montada ele vira **▶ PESQUISAR 3 TERMOS**
e o `title` lista quais. Fila esquecida de ontem que dispara sozinha ao clicar
em PESQUISAR era confusão garantida.

O campo de nicho tem um **＋** que joga o termo na fila (aceita colar
`um, dois, três` de uma vez). Com fila montada, **PESQUISAR** roda os termos em
sequência — terminou um, começa o próximo na hora — e aparece um **PARAR A
FILA**, que interrompe depois do termo atual. Cada termo é uma pesquisa
completa: coleta, varredura, envio e cópia de mídia. A fila é serial de
propósito; duas coletas ao mesmo tempo brigariam pela mesma aba.

Em *Configurações de pesquisa*:

| Campo | Padrão | O que é |
|---|---|---|
| Tempo por pesquisa (s) | **300** (era 90) | teto de rolagem por termo, até 1800 |
| Rodadas sem novidade antes de parar | **12** (era 5 fixo) | quantas rodadas de 1,8s sem anúncio novo antes de desistir |

O segundo campo importa mais do que parece: com o limite antigo de 5, uma
pesquisa de 5 minutos morria em ~10 segundos — bastava a Biblioteca demorar
para paginar.

### Estado da pesquisa vive no storage

O service worker do MV3 é encerrado quando fica ocioso, e uma pesquisa de 5
minutos passa por vários desses momentos. Com o estado só em memória, o worker
renascia sem saber que havia coleta em curso: o **PARAR não fazia nada** e o
popup recebia *"A listener indicated an asynchronous response by returning true,
but the message channel closed"*.

Agora: `PESQUISAR` e `PESQUISAR_FILA` respondem na hora (`{ok, iniciado}`) e o
andamento é lido por `STATUS`; `rodando`, `filaEmCurso` e `pedidoParar` ficam em
`chrome.storage.local` (chave `execucao`, com carimbo de tempo — marca de mais
de 10 min é descartada); e um ping a cada 20s em `chrome.runtime.getPlatformInfo`
segura o worker vivo enquanto há trabalho.

### A rolagem sempre tem freio

Enquanto a extensão rola a página, uma faixa aparece no topo —
`Minerador coletando… 39 anúncios · 119s` — com botão **parar**. Além dele:

- **gesto deliberado** interrompe na hora: rolar **para cima** (você está
  brigando com a rolagem), `Esc`, `PageUp` ou `Home`. Rolar para baixo não
  cancela — parar em qualquer toque na roda fazia a coleta morrer no meio e
  parecia travamento;
- **PARAR AGORA** no popup manda `PARAR_COLETA` para toda aba da Biblioteca,
  além de encerrar a fila.

Isso importa porque uma coleta dura até o *Tempo por pesquisa* (padrão 300s).
Sem freio, uma pesquisa disparada minutos antes continuava rolando a página
"sozinha", sem nada na tela dizendo de onde vinha.

**Pesquisa automática**: com o toggle ligado, qualquer visita manual à
Biblioteca é capturada em segundo plano — **sem rolar a página**. Ela leva só o
que a Biblioteca já carregou (`COLETAR` com `rolar: false`). Quem quiser a
rolagem automática marca *Deixar a pesquisa automática rolar a página*; a
rolagem continua sendo o padrão da pesquisa manual, que é quando você pediu.

## Painel flutuante na Biblioteca

`painel.js` monta o próprio `popup.html` num `<iframe>` flutuante dentro da
Biblioteca — interface com uma fonte de verdade só; o arquivo cuida da moldura:

| Ação | Como |
|---|---|
| mover | arrastar pelo cabeçalho |
| redimensionar | pega no canto inferior direito (mín. 250×160) |
| recolher | botão `–` ou dois cliques no cabeçalho |
| transparência | botão `◐` alterna 100% → 85% → 60% |
| trocar de lado | botão `⇄` encosta na borda oposta |
| fechar / reabrir | `✕` some com ele e deixa o atalho ⛏️ no canto |

Posição, tamanho, transparência e estado ficam em `chrome.storage.local`
(`painelGeo`) — reabre como você deixou. Liga e desliga em *Configurações de
pesquisa → Painel flutuante dentro da Biblioteca*; com ele ligado, o popup da
barra não abre sozinho (seria a mesma interface duas vezes).

Dois detalhes que custaram teste: montar o iframe em `document_start`, antes de
o parser criar o `<body>`, **trava o carregamento da página** — por isso a
espera pelo `<body>`; e sem a guarda `window.top === window` o painel se
montaria dentro do próprio iframe, recursivamente. Se o CSP do Facebook barrar
o iframe da extensão, o painel percebe (o popup manda `popup-pronto` ao subir) e
troca o quadro vazio por um aviso com atalho para o painel web.

## Barra de cópia em cima do anúncio

`overlay.js` marca cada cartão da Biblioteca (acha pelo texto "Identificação da
biblioteca: N") e injeta uma barra com quatro botões:

| Botão | O que faz |
|---|---|
| ⬇ | abre a mídia original (URL do vídeo/imagem que veio no JSON) em outra aba |
| **COPIAR** | menu: Texto principal · Título · Descrição · URL do site · Chamada para ação · URL do anúncio na Biblioteca · Todas as informações |
| ★ | salva aquele anúncio: ingere em `/api/anuncios` **e** manda para ★ Melhores |
| — | qualquer botão avisa *"A extensão foi recarregada — atualize esta página (F5)"* quando o content script ficou órfão |
| ▤ | abre o painel |
| selo | **tempo rodando** do anúncio: `708 dias · 23 meses`, verde a partir de 60 dias |

A ★ vai para Melhores por um motivo prático: um anúncio salvo sozinho conta
como **1 anúncio ativo**, e o filtro padrão do painel pede 2 — ele entrava no
banco e não aparecia na tela. Melhores ignora filtro, então o que você marcou
está sempre lá. O aviso na tela diz para onde foi.

O texto copiado sai do JSON capturado, não do DOM — no cartão a copy vem
truncada em "Ver mais" e sem `link_url`. Quando o anúncio ainda não apareceu em
nenhuma resposta (rolagem muito rápida), a barra cai num plano B lendo o
próprio cartão, e o que dá para tirar de lá é copiado do mesmo jeito.

A primeira leva de anúncios não chega por GraphQL: o Facebook embute o JSON em
`<script>` no HTML. `content.js` varre esses scripts na carga — sem isso os
primeiros cartões da página ficavam sem dado (a coleta também os perdia).

**Abrir sozinho**: em *Configurações de pesquisa*, "Abrir a extensão ao entrar
na Biblioteca" (ligado por padrão) chama `chrome.action.openPopup()` quando uma
aba da Biblioteca termina de carregar. Exige Chrome 127+ e a janela em foco;
quando o Chrome recusa, a barra de cópia aparece no anúncio do mesmo jeito.

## Mídia do anúncio (vídeo na capa)

A URL que a Biblioteca entrega é assinada e expira em horas (`oe=` no query
string) — guardar a URL crua dava capa quebrada no dia seguinte, e no caso de
vídeo dava um `<img src="....mp4">`, que nunca carrega. Por isso o backend
**copia** a mídia para o Vercel Blob:

1. `content.js` captura três URLs por anúncio: `midia_url` (HD, para baixar),
   `midia_sd` (leve, vira a capa) e `midia_poster` (quadro de pré-visualização).
   As três podem vir de `snapshot.videos[]`, `images[]` ou `cards[]`.
2. `/api/anuncios` enfileira na tabela `midias`.
3. `POST /api/midias?limite=3` (ou `/dados/midias`) baixa da CDN da Meta e sobe
   no Blob, em lotes — mesmo desenho do enriquecimento, porque serverless não
   tem worker de fundo. O painel mói essa fila sozinho e vai repintando.
4. A capa toca o vídeo (`muted loop autoplay playsinline`) com o poster como
   pôster; sem vídeo, cai no `og:image` do destino.

Detalhes que importam:

- **`Referer: facebook.com` no download.** Sem ele a CDN devolve 403 em parte
  dos arquivos.
- **SD, não HD.** A capa é um quadrado de ~230px; HD multiplicaria por 5 o
  armazenamento sem diferença visível. Vídeo SD dá ~4,5 MB.
- **Teto de armazenamento** (`MINERADOR_MAX_BYTES`, padrão 600 MB). Batendo no
  teto, o poster continua sendo copiado e só o vídeo é dispensado.
- **Tudo comprimido antes do banco.** Capa do anúncio e og:image do site
  passam por `midias.comprimir` (WebP 320px, q50, ~5 KB) e vão para a tabela
  `capas`, servidas em `/capa/<chave>`. Vídeo não é guardado — só o quadro de
  capa: o vídeo mais enxuto pesaria centenas de vezes a miniatura.
- **Cópia na hora da coleta.** `/api/anuncios` já mói a fila de capas por até
  20s antes de responder; URL da Meta vence em ~5 dias (`oe=`) e o painel
  descarta a que já venceu em vez de pintar quadro quebrado.
- **Fila do mais novo para o mais velho**: assinatura expira, então o que
  acabou de ser coletado é o que ainda dá para baixar. Anúncio antigo
  (coletado antes desta mudança) quase sempre falha com 403 — só a próxima
  coleta daquele anúncio resolve.

## Filtros de low ticket

**O minerador só guarda low ticket** (`backend/lowticket.py`): preço detectado
até R$ 50, checkout ou plataforma de venda, destino que vende. A extensão já
descarta anúncio sem link ou com link de app/perfil/WhatsApp; o backend faz o
mesmo na ingestão e, depois de cada lote de enriquecimento, esconde
(`excluido_em`, reversível) o que foi reprovado. Site fora do ar é refeito até
3 vezes antes de sair. Melhores não é tocado.

O painel abre **sem cortar nada** (mín. 1 anúncio, 0 dias). O padrão antigo era
2 e 3, e ele escondia em silêncio — 34 de 56 anunciantes sumiam da tela sem
explicação. Quando algum filtro corta, o card do topo passa a dizer
`22 ANUNCIANTES · 34 FORA DO FILTRO`, e o `resumo.total` da API carrega a
contagem sem filtro para isso.

Além de mín. de anúncios ativos e dias rodando, o painel filtra por:

| Filtro | O que faz |
|---|---|
| **Preço de / até** | faixa sobre o valor numérico (`destinos.preco_valor`), não sobre o texto |
| **Operação** | infoproduto · e-commerce · só meio de pagamento · **infoproduto ou e-commerce** |
| **com preço** | esconde quem ainda não teve preço detectado |
| **só quem vende** | esconde destino que é perfil, WhatsApp, link de bio ou loja de app |
| **⚡ Low ticket** | preset: até 97, com preço, só quem vende, 5+ anúncios, 7+ dias, ordenado do mais barato |

O preço vira número no enriquecimento (`preco_valor` + `preco_moeda`), com a
moeda saindo do código escrito na página e, na falta dele, do domínio. Sem
isso, ordenar e filtrar comparava string — `"R$ 100"` vinha antes de
`"R$ 9,90"`. O preço do anunciante é o **menor** dos destinos dele: em low
ticket, o que importa é a oferta de entrada.

A classificação da operação sai de `TIPO_GATEWAY` em `gateways.py`: Kiwify,
Hotmart, Cakto, Ticto e afins são `infoproduto`; Shopify, Nuvemshop e Yampi são
`ecommerce`; o resto é `pagamento` (selo de checkout, não plataforma).

## Visualizações do resultado

Três modos, no canto direito das abas — a escolha fica no `localStorage`, então
o painel reabre do jeito que você deixou:

| Modo | Para quê |
|---|---|
| **▤ Tabela** | comparar número a número: score, ativos, dias, gateway, preço lado a lado |
| **▦ Cartões** | foto grande com os dados embaixo — bater o olho no que está sendo vendido |
| **⣿ Mural** | só as capas, em grade apertada; nome e métricas aparecem ao passar o mouse |

Todo cartão tem a mesma altura (`grid-auto-rows:1fr`) e a capa é um quadrado
fixo com a mídia dentro em `position:absolute`. Sem isso, um vídeo vertical
impunha a própria altura — `height:100%` num pai que só tem `aspect-ratio` não
segura — e cada cartão saía de um tamanho. Os atalhos do rodapé ficam colados na
base (`margin-top:auto`), então copy curta não encurta o cartão.

A foto usa `contain` nos cartões (og:image de oferta costuma ser banner
1200x628, e corte quadrado comia a chamada) e `cover` no mural, onde o que vale
é a densidade. Sem foto, o quadro do mural mostra o nome do anunciante.

O seletor de ordem (score, anúncios ativos, tempo rodando, menor preço, nome)
vale nos três modos — na tabela, clicar no cabeçalho continua funcionando e o
seletor acompanha. Ordenar por preço lê o número de verdade (`R$ 1.299,90` e
`$25.000` na mesma lista) e joga quem não tem preço para o fim.

## Melhores e limpeza

Cada linha mostra a **foto do produto**: o `og:image` da página de destino
(twitter:image e product:image como reserva), resolvido contra a URL final. Se
o destino ainda não foi enriquecido, cai na mídia do próprio anúncio — a
etiqueta embaixo diz de onde veio. Rede social e agregador de link não entram:
ali o `og:image` é o logo do WhatsApp, não o produto.

O **✕** exclui o anunciante dos resultados (em Melhores, tira o retrato salvo)
— **sem caixa de confirmação**: some na hora e fica um **Desfazer** no rodapé
por 9 segundos. Isso é possível porque excluir marca `excluido_em` em vez de
apagar; `montar_ofertas` ignora quem está marcado e `/dados/restaurar` limpa a
marca.

**Seleção múltipla**: caixa em cada linha, cartão e quadro do mural, mais
"selecionar tudo" no cabeçalho da tabela. Com algo marcado aparece uma barra
com **Salvar em Melhores** e **Excluir selecionados** — os dois em lote, uma
requisição só (`page_ids`), e a exclusão em lote também tem Desfazer.

No painel, a ★ de cada linha salva o anunciante na aba **Melhores**. O que é
guardado é o *retrato* da oferta (score, gateway, preço, copy, país, data),
não uma referência: **Limpar resultados** apaga anúncios e pesquisas do
usuário e os salvos continuam de pé. `destinos` também não é apagado — é cache
compartilhado de redirects/gateway e caro de refazer.

**Limpar resultados apaga tudo do usuário, sem desfazer.** O único jeito de
voltar é ponto-no-tempo do Neon (branch a partir de um timestamp anterior).

## Mercados de língua espanhola

No popup, *Configurações de filtro*: **País** (México, Argentina, Colômbia,
Chile, Peru, Equador, Uruguai, Espanha) e **Idioma do anúncio**. O idioma vira
`content_languages[0]` na URL da Biblioteca — sem ele um país hispano devolve
também anúncio em inglês e português rodando no mesmo mercado. As sugestões de
termo trocam para espanhol sozinhas quando o país ou o idioma é hispano.

O país fica gravado por anúncio, então o painel filtra por ele e a mesma conta
serve para os dois mercados.

Do lado do enriquecimento: preço é lido nas duas convenções de número
(`1.234,56` e `1,234.56`), em `R$ $ US$ € S/ MXN ARS COP CLP PEN UYU`, com faixa
de valor plausível por moeda — `$25.000` é preço em ARS e lixo em BRL. A moeda
da página sai do código escrito no HTML e, na falta dele, do domínio.

## Gateways reconhecidos

**BR / infoproduto:** Kiwify, Hotmart, Eduzz, Monetizze, Braip, Cakto, Perfect
Pay, Ticto, Kirvano, Greenn, Lastlink, Hubla, Doppus, Payt, Digital Manager
Guru, Pepper, Voomp, TriboPay, Zouti, Astron, Yampi, Appmax.

**Ecommerce:** Shopify, Nuvemshop/Tiendanube.

**Meios de pagamento:** Mercado Pago, PagSeguro, Stripe, PayPal, Asaas,
InfinitePay, PayU, dLocal, ePayco, Wompi, Bold, Openpay, Conekta, Clip, Kueski
Pay, Culqi, Izipay, Niubiz, Flow, Webpay, Khipu, Mobbex, Rebill, Redsys, Bizum,
Paycomet.

Quando os dois aparecem na mesma página, a **plataforma ganha do meio de
pagamento**: selo do Mercado Pago no rodapé de uma loja Shopify não faz dela um
checkout do Mercado Pago. Marcador textual também é ignorado quando o destino
final é rede social ou agregador de links — o HTML do Instagram cita gateway
que não tem nada a ver com a oferta.

Novos: acrescentar em `backend/gateways.py` (e no conjunto `PAGAMENTO`, se for
meio de pagamento).

## Limites conhecidos

- Anúncio com CTA de WhatsApp não expõe o número (a Meta remove o parâmetro);
  esses ficam sem destino e sem gateway.
- Sem varredura profunda, "anúncios ativos" é o que apareceu na busca — o
  painel marca esses como `parcial`.
- Preço é heurística sobre o HTML: página com muito valor promocional pode
  devolver o número errado.
- Varredura profunda navega a aba várias vezes; muitos anunciantes seguidos
  aumentam o risco de throttle do Facebook. Padrão é 8.

## Endpoints

| Método | Rota | Uso |
|---|---|---|
| POST | `/api/login` | devolve token da extensão |
| GET | `/api/me` | plano e usos restantes |
| POST | `/api/anuncios` | ingestão em lote |
| POST | `/api/anunciantes` | contagem real por anunciante |
| POST | `/api/enriquecer` | resolve um lote de destinos; devolve `pendentes` |
| GET | `/api/saude` | checa a conexão com o banco |
| GET | `/api/ofertas` | ofertas agregadas (filtros: `min_anuncios`, `min_dias`, `gateway`, `pais`, `termo`, `q`) |
| GET/POST | `/dados/favoritos` | lista / salva um anunciante em **Melhores** (sessão) |
| POST | `/dados/favoritos/remover` | tira de Melhores |
| POST | `/api/midias` | copia um lote de mídias para o Blob; devolve `pendentes` |
| POST | `/dados/excluir` | apaga os anúncios de um `page_id` |
| POST | `/dados/limpar` | apaga anúncios e pesquisas do usuário |
| GET | `/api/anunciante/<page_id>` | anúncios de um anunciante |
