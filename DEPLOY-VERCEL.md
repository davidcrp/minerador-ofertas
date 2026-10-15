# Deploy na Vercel (Neon Postgres)

## Estado atual (já no ar)

| Item | Valor |
|---|---|
| Projeto Vercel | `minerador-ofertas` (scope `davids-projects-5a541fc6`) |
| URL | https://minerador-ofertas-umber.vercel.app |
| Painel | `/login` — usuário `admin` |
| Saúde | `/api/saude` → `{"ok": true, "banco": "conectado"}` |
| Banco | **Supabase** `supabase-fulvous-planet` (integração do marketplace da Vercel, pooler `:6543`) |

Antes era Neon. Saiu porque a cota de transferência do plano gratuito é da
**organização Neon**, não do projeto: criar um projeto novo não deu cota nova, e
o banco recém-criado bloqueou junto com o antigo. O Supabase entra com cota
própria e bem mais folgada em transferência.

Duas particularidades do Supabase que o `db.py` resolve:

- a URL vem com `?supa=base-pooler.x`, que o libpq recusa (`invalid URI query
  parameter`) — `limpar_url()` mantém só os parâmetros que o libpq entende;
- o pooler `:6543` é *transaction mode* e não guarda prepared statement entre
  comandos — a conexão abre com `prepare_threshold=None`.

Redeploy: `cd minerador/backend && npx vercel --prod`.

**Cota é o risco real deste plano.** Já derrubou duas coisas: o Vercel Blob
(1 GB, suspenso — por isso `MINERADOR_BLOB=0` desliga a cópia de mídia) e o
Neon compartilhado (transferência de dados). O que consome banco é leitura
repetida: o painel recarrega sozinho e `montar_ofertas` lê todos os anúncios.
Por isso hoje ele recarrega a cada 2 min, só com a aba visível, e a consulta
traz só as colunas usadas com `LEFT(texto, 400)`.

**Não** publique este app dentro do projeto `separador-caixa` — ele é outro app
em produção e um `--prod` lá o substituiria.

**Sem `rewrites` no `vercel.json`.** A Vercel passou a entregar ao framework o
path *reescrito*, então o `/(.*) → /api/index` antigo fazia todas as rotas
caírem em `/api/index` (405). A detecção de Flask já roteia tudo para
`api/index.py` sozinha.

---

O que muda em relação ao local: **SQLite sai, Neon Postgres entra** (o disco da
Vercel é efêmero — banco em arquivo some a cada deploy/cold start) e o
enriquecimento dos destinos deixa de rodar em thread de fundo e passa a ser
puxado em lotes (`/api/enriquecer`) pelo painel e pela extensão.

A pasta a publicar é **`minerador/backend`** — é ela que tem `api/index.py`,
`vercel.json` e `requirements.txt`.

O coletor Playwright (`ads_library/fb_ads.py`) **não** vai para a Vercel:
serverless não roda navegador. Ele continua sendo ferramenta local.

---

## 1. Criar o banco no Neon

No painel da Vercel: **Storage → Create Database → Neon (Postgres) → Connect
to Project**. A integração injeta `DATABASE_URL` no projeto sozinha.

Copie a connection string **pooled** (o host tem `-pooler`) — é a certa para
serverless.

## 2. Variáveis de ambiente do projeto

Em **Settings → Environment Variables**:

| Variável | Valor |
|---|---|
| `MINERADOR_SECRET` | string aleatória longa (assina o cookie de sessão) |
| `DATABASE_URL` | criada pela integração do Neon |

Gerar o secret:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

O app **recusa subir na Vercel sem `MINERADOR_SECRET`** — isso é proposital:
secret aleatório por instância derrubaria sua sessão a cada cold start.

## 3. Criar o esquema e o seu usuário

Da sua máquina, apontando para o Neon (uma vez só):

```bash
cd minerador/backend
pip install -r requirements.txt
```

PowerShell:

```bash
$env:DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require"; $env:MINERADOR_ADMIN_SENHA="umaSenhaForteAqui"; python setup_db.py
```

Trocar a senha depois:

```bash
python setup_db.py --senha novaSenhaForte
```

## 4. Publicar

Pela CLI, de dentro de `minerador/backend`:

```bash
npx vercel --prod
```

Pelo GitHub: importe o repositório e defina **Root Directory =
`minerador/backend`**.

Confira depois: `https://minerador-ofertas-umber.vercel.app/api/saude` deve responder
`{"ok": true, "banco": "conectado"}`.

## 5. Apontar a extensão para a nuvem

Na extensão: **Configurações de pesquisa → Servidor** →
`https://minerador-ofertas-umber.vercel.app`. O Chrome vai pedir permissão para o domínio —
aceite. Depois entre com o mesmo usuário e senha do painel.

---

## Detalhes que importam

**Enriquecimento em lotes.** `/api/enriquecer?limite=8` resolve até 8 destinos
por chamada e devolve quantos faltam. O painel e a extensão repetem até zerar.
Cada destino tem no máximo 3 tentativas, então link morto não fica em loop.

**maxDuration.** `vercel.json` pede 60s por invocação. Se o seu plano recusar,
baixe para 30 em `vercel.json` — o lote de 8 costuma fechar em ~15s.

**Conexões do Neon.** Uma conexão por request, sempre fechada no fim. Use a
string pooled; a direta estoura o limite de conexões com poucas requisições
simultâneas.

**CORS.** `/api/*` responde `Access-Control-Allow-Origin: *` porque a extensão
chama de uma origem `chrome-extension://`. Não há cookie nessas rotas — a
autenticação é o Bearer token. O painel (`/`, `/dados/*`) continua por sessão.

**Segurança.** O painel fica exposto na internet: use senha forte, não reuse
senha de outro serviço. Não há tela de cadastro — usuário único, criado pelo
`setup_db.py`.

**Rodar local depois disso.** Continua funcionando, só que apontando para o
mesmo Neon:

```bash
$env:DATABASE_URL="postgresql://..."; $env:MINERADOR_SECRET="qualquercoisa"; python minerador/backend/app.py
```
