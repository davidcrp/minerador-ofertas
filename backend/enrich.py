"""Enriquecimento dos destinos: segue redirects, baixa o HTML, detecta gateway.

Em serverless não existe worker em background — a função morre junto com a
resposta. Então o trabalho é feito em LOTES sob demanda: quem chama
`/api/enriquecer` processa alguns destinos e devolve quantos ainda faltam;
o cliente repete até zerar.
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from urllib.parse import urljoin

import requests

import lowticket
import midias
from db import get_db
from gateways import (IGNORAR, achar_preco, achar_whatsapp, detectar, host,
                      moeda_da_pagina, preco_da_copy, preco_estruturado,
                      valor_e_moeda)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA,
           "Accept-Language": "pt-BR,pt;q=0.9,es;q=0.8,es-419;q=0.7,en;q=0.6"}
LIMITE_HTML = 400_000
MAX_TENTATIVAS = 3

RE_TITULO = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
RE_META = re.compile(r"<meta\b[^>]*>", re.I)
RE_ATRIB = re.compile(r"""(property|name|content)\s*=\s*["']([^"']*)["']""", re.I)

# Ordem de preferência: o que a própria página declara como imagem de
# compartilhamento é a foto do produto em loja e página de venda.
CHAVES_IMAGEM = ("og:image:secure_url", "og:image", "twitter:image",
                 "twitter:image:src", "product:image")


def achar_imagem(html: str, base: str) -> str:
    achadas: dict[str, str] = {}
    for tag in RE_META.findall(html or ""):
        atrib = {k.lower(): v for k, v in RE_ATRIB.findall(tag)}
        chave = (atrib.get("property") or atrib.get("name") or "").lower()
        if chave in CHAVES_IMAGEM and atrib.get("content"):
            achadas.setdefault(chave, unescape(atrib["content"]).strip())
    for chave in CHAVES_IMAGEM:
        if achadas.get(chave):
            try:
                return urljoin(base, achadas[chave])[:1000]
            except ValueError:
                return ""
    return ""


RE_IMG = re.compile(r"<img\b[^>]*>", re.I)
RE_SRC = re.compile(r"""\b(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']""", re.I)
RE_LARGURA = re.compile(r"""\bwidth\s*=\s*["']?(\d+)""", re.I)
RE_ROTULO = re.compile(r"""\b(?:class|alt|id)\s*=\s*["']([^"']*)["']""", re.I)
# logo, ícone, selo de pagamento, pixel: nada disso é foto de produto
RUIDO_IMG = re.compile(r"logo|icon|favicon|sprite|selo|badge|pixel|avatar|spinner|"
                       r"placeholder|whatsapp|pagamento|payment|bandeira|\.svg|\.gif|"
                       r"^data:", re.I)


def achar_imagem_html(html: str, base: str) -> str:
    """Reserva para página sem og:image: a primeira <img> que não é logo nem
    ícone costuma ser a foto do produto no topo da página de venda."""
    for tag in RE_IMG.findall(html or "")[:60]:
        m = RE_SRC.search(tag)
        if not m:
            continue
        src = unescape(m.group(1)).strip()
        rotulos = " ".join(RE_ROTULO.findall(tag))
        if RUIDO_IMG.search(src) or RUIDO_IMG.search(rotulos):
            continue
        largura = RE_LARGURA.search(tag)
        if largura and int(largura.group(1)) < 150:
            continue
        try:
            return urljoin(base, src)[:1000]
        except ValueError:
            continue
    return ""


def registrar(urls) -> int:
    """Marca URLs novas como pendentes. Não busca nada — só enfileira."""
    novas = [u for u in {*urls} if u and u.startswith("http")]
    if not novas:
        return 0
    conn = get_db()
    with conn:
        conn.cursor().executemany(
            "INSERT INTO destinos (url, status) VALUES (%s, 'pendente') ON CONFLICT (url) DO NOTHING",
            [(u,) for u in novas],
        )
    conn.close()
    return len(novas)


def pendentes() -> int:
    conn = get_db()
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM destinos WHERE status = 'pendente' AND tentativas < %s",
        (MAX_TENTATIVAS,),
    ).fetchone()["c"]
    conn.close()
    return n


# Página de desafio anti-robô (Cloudflare e parentes): responde 200 ou 403 com
# um HTML que não é o site.
RE_DESAFIO = re.compile(r"just a moment|cf-chl|challenge-platform|attention required|"
                        r"verifying you are human|checking your browser|"
                        r"enable javascript and cookies", re.I)
HTTP_BLOQUEIO = {401, 403, 406, 429, 503}


def bloqueado(http: int, html: str) -> bool:
    """O site respondeu, mas não deixou ler: isso não é 'sem preço'."""
    if http in HTTP_BLOQUEIO:
        return True
    return bool(html) and len(html) < 20_000 and bool(RE_DESAFIO.search(html))


def _baixar(url: str, timeout: float = 12) -> tuple[list[str], str, str, int]:
    """Devolve (cadeia_de_urls, html, erro, status_http). Só rede — nada de
    banco aqui, porque isso roda em thread."""
    cadeia = [url]
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout,
                         allow_redirects=True, stream=True)
        cadeia = [url] + [h.url for h in r.history] + [r.url]
        cadeia = [u for i, u in enumerate(cadeia) if u and u not in cadeia[:i]]

        tipo = (r.headers.get("Content-Type") or "").lower()
        if "html" not in tipo and "text" not in tipo:
            r.close()
            return cadeia, "", "", r.status_code

        pedacos, total = [], 0
        for pedaco in r.iter_content(chunk_size=16384):
            pedacos.append(pedaco)
            total += len(pedaco)
            if total >= LIMITE_HTML:
                break
        r.close()
        return (cadeia, b"".join(pedacos).decode(r.encoding or "utf-8", errors="replace"),
                "", r.status_code)
    except requests.RequestException as e:
        return cadeia, "", str(e)[:300], 0


# Página feita em React/Vite (bolt.new, lovable, netlify, vercel): o HTML é uma
# casca vazia e preço e link de checkout moram nos arquivos JS. Sem ler esses
# arquivos a oferta saía "sem preço, sem checkout" e era podada do low ticket.
RE_SCRIPT_SRC = re.compile(r"""<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.m?js)[^"']*["']""", re.I)
RE_CHUNK = re.compile(r"""["'](?:\./|/?assets/|/_next/static/chunks/)[\w./-]+?\.m?js["']""")
# Pedaço que costuma ter a oferta vem primeiro; biblioteca de terceiros, nunca.
CHUNK_BOM = re.compile(r"pric|plan|offer|ofert|check|buy|compr|cta|pre[cç]o|valor|pagin|page|"
                       r"index|main|app", re.I)
CHUNK_RUIM = re.compile(r"vendor|react|polyfill|framework|lucide|icons?[-.]|chart|"
                        r"supabase|firebase|lottie|motion|webvitals", re.I)
LIMITE_JS = 1_500_000


def _parece_spa(html: str) -> bool:
    texto = re.sub(r"<script\b.*?</script>|<style\b.*?</style>|<[^>]+>", " ", html or "",
                   flags=re.S | re.I)
    pouco_texto = len(re.sub(r"\s+", " ", texto).strip()) < 600
    return pouco_texto and bool(RE_SCRIPT_SRC.search(html or ""))


def _baixar_js(html: str, base: str) -> str:
    """Lê os JS do próprio site (mesmo host) atrás de preço e checkout."""
    origem = host(base)
    fila = [urljoin(base, s) for s in RE_SCRIPT_SRC.findall(html)]
    vistos, partes, total = set(), [], 0
    while fila and len(vistos) < 14 and total < LIMITE_JS:
        u = fila.pop(0)
        if u in vistos or host(u) != origem or CHUNK_RUIM.search(u.rsplit("/", 1)[-1]):
            continue
        vistos.add(u)
        try:
            r = requests.get(u, headers=HEADERS, timeout=8)
            if r.status_code != 200:
                continue
            js = r.text[:LIMITE_JS - total]
        except requests.RequestException:
            continue
        partes.append(js)
        total += len(js)
        novos = [urljoin(u, m.strip("\"'")) for m in RE_CHUNK.findall(js)]
        novos.sort(key=lambda x: 0 if CHUNK_BOM.search(x.rsplit("/", 1)[-1]) else 1)
        fila += [n for n in novos if n not in vistos]
    return "\n".join(partes)


def _preco_de(html: str, texto: str, url: str) -> tuple[str, float, str]:
    """(texto, valor, moeda). Dado estruturado da página primeiro; sem ele, o
    valor que mais se repete no texto."""
    preco, valor, moeda = preco_estruturado(html, url)
    if valor:
        return preco, valor, moeda
    preco = achar_preco(texto, url)
    valor, moeda = valor_e_moeda(preco, moeda_da_pagina(texto, url))
    return preco, valor, moeda


def _preco_das_copies(conn, urls: list[str]) -> dict[str, tuple]:
    """Último recurso para destino sem preço: o que o próprio anúncio diz
    ("por apenas R$ 19,90"). Junta as copies de cada link e lê o preço delas."""
    if not urls:
        return {}
    textos: dict[str, list[str]] = {}
    paises: dict[str, str] = {}
    for r in conn.execute("""
        SELECT link_url, pais, titulo, legenda, texto FROM anuncios
        WHERE link_url = ANY(%s) AND excluido_em IS NULL LIMIT 400
    """, (urls,)).fetchall():
        textos.setdefault(r["link_url"], []).append(
            " ".join(filter(None, (r["titulo"], r["legenda"], r["texto"]))))
        paises.setdefault(r["link_url"], r["pais"] or "BR")
    saida = {}
    for url, partes in textos.items():
        achado = preco_da_copy(" \n ".join(partes), paises.get(url, "BR"))
        if achado[1]:
            saida[url] = achado
    return saida


def _analisar(url: str) -> tuple:
    cadeia, html, erro, http = _baixar(url)
    return _montar(url, cadeia, html, erro, http, "servidor")


def _montar(url: str, cadeia: list[str], html: str, erro: str, http: int,
            lido_por: str) -> tuple:
    """Do HTML para a linha de `destinos`. O HTML pode ter vindo do servidor
    (requests) ou do navegador de quem usa a extensão — a análise é a mesma."""
    if html and _parece_spa(html):
        # o JS entra na análise de gateway/preço; título e imagem seguem do HTML
        js = _baixar_js(html, cadeia[-1] if cadeia else url)
    else:
        js = ""
    texto = html + "\n" + js if js else html
    gateway, evidencia, checkout = detectar(cadeia, texto)
    titulo = ""
    m = RE_TITULO.search(html or "")
    if m:
        titulo = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()[:200]
    final = cadeia[-1] if cadeia else url
    # og:image de rede social é o logo dela, não o produto anunciado.
    imagem = "" if host(final) in IGNORAR else (
        achar_imagem(html, final) or achar_imagem_html(html, final))
    preco, valor, moeda = _preco_de(html, texto, final)
    # LP de low ticket muitas vezes não mostra preço: ele só aparece no
    # checkout. Sem preço a oferta era reprovada e sumia — então vale uma
    # visita ao checkout que a própria página aponta.
    if not valor and checkout and checkout != final and not erro:
        _, html_ck, _, _ = _baixar(checkout, timeout=8)
        if html_ck:
            preco, valor, moeda = _preco_de(html_ck, html_ck, checkout)
            if valor:
                evidencia = (evidencia + " · preço lido no checkout")[:300]
    # A og:image vai comprimida para o banco: link externo de loja some quando
    # a página sai do ar, e era a última reserva de capa que sobrava.
    capa = (b"", "")
    if imagem.startswith("http"):
        try:
            capa = midias.baixar_comprimido(imagem, referer=final)
        except Exception:
            pass
    return capa, (final, host(final), titulo, imagem,
            gateway, evidencia, checkout,
            preco, valor or None, moeda, achar_whatsapp(texto),
            "erro" if erro else ("bloqueado" if bloqueado(http, html) else "ok"),
            erro, http or None, lido_por, url)


def _gravar(conn, analisados) -> None:
    """Grava as linhas analisadas em `destinos` (mesma transação de quem chama)."""
    cur = conn.cursor()
    # linha: (final, dominio, titulo, imagem, gateway, evidencia, checkout,
    #         preco, valor, moeda, whatsapp, status, erro, http, lido_por, url)
    sem_preco = [linha[15] for _, linha in analisados
                 if linha[11] in ("ok", "bloqueado") and not linha[8]]
    da_copy = _preco_das_copies(conn, sem_preco)
    resultados = []
    for (jpeg, mime), linha in analisados:
        linha = list(linha)
        if jpeg:
            linha[3] = midias.guardar_capa(cur, midias.chave_site(linha[3]), jpeg, mime)
        if linha[15] in da_copy:
            linha[7], linha[8], linha[9] = da_copy[linha[15]]
            linha[5] = ((linha[5] or "") + " · preço da copy do anúncio").strip(" ·")[:300]
        resultados.append(linha)
    cur.executemany("""
        UPDATE destinos SET url_final=%s, dominio=%s, titulo_pagina=%s, imagem=%s,
            gateway=%s, gateway_evidencia=%s, checkout_url=%s, preco=%s,
            preco_valor=%s, preco_moeda=%s, whatsapp=%s,
            status=%s, erro=%s, http_status=%s, lido_por=%s, atualizado_em=NOW()
        WHERE url=%s
    """, resultados)


# ---------------------------------------------------------------- leitura pelo navegador

# O servidor roda em datacenter: é quem mais leva 403, desafio anti-robô e
# "página branca" de cloaker. O navegador de quem usa a extensão tem IP
# residencial e Chrome de verdade — então a extensão baixa a página e manda o
# HTML para cá; a análise é a mesma.
#
# Candidato: o site bloqueou o servidor, ou o servidor leu e não achou nem
# preço nem checkout (cara de página camuflada). Só o que é recente e que
# ainda não foi lido pelo navegador — cada destino tem uma segunda chance, não
# um laço infinito.
_CANDIDATO = """
    COALESCE(d.lido_por, 'servidor') <> 'navegador'
    AND d.atualizado_em > NOW() - INTERVAL '7 days'
    AND (d.status = 'bloqueado'
         OR (d.status = 'ok' AND COALESCE(d.checkout_url, '') = ''
             AND d.preco_valor IS NULL))
    AND EXISTS (SELECT 1 FROM anuncios a WHERE a.link_url = d.url AND a.user_id = %s)
"""


def para_navegador(user_id: int, limite: int = 4) -> dict:
    conn = get_db()
    urls = [r["url"] for r in conn.execute(
        f"SELECT d.url FROM destinos d WHERE {_CANDIDATO}"
        " ORDER BY (d.status = 'bloqueado') DESC, d.atualizado_em DESC LIMIT %s",
        (user_id, limite)).fetchall()]
    total = conn.execute(f"SELECT COUNT(*) AS c FROM destinos d WHERE {_CANDIDATO}",
                         (user_id,)).fetchone()["c"]
    conn.close()
    return {"urls": urls, "pendentes": total}


def receber_do_navegador(user_id: int, itens: list) -> dict:
    """`itens` = [{url, url_final, status, html}]. Aceita apenas destino que este
    usuário tem e que estava na fila do navegador."""
    pedidos = {}
    for i in itens[:8]:
        if isinstance(i, dict) and str(i.get("url") or "").startswith("http"):
            pedidos[str(i["url"])] = i
    if not pedidos:
        return {"lidos": 0, "aproveitados": 0, **para_navegador(user_id, 0)}

    conn = get_db()
    validos = [r["url"] for r in conn.execute(
        f"SELECT d.url FROM destinos d WHERE d.url = ANY(%s) AND {_CANDIDATO}",
        (list(pedidos), user_id)).fetchall()]
    conn.close()

    def um(url):
        i = pedidos[url]
        html = str(i.get("html") or "")[:LIMITE_HTML]
        final = str(i.get("url_final") or url)
        final = final if final.startswith("http") else url
        try:
            http = int(i.get("status") or 0)
        except (TypeError, ValueError):
            http = 0
        if not html or bloqueado(http, html):
            return None                      # o navegador também ficou de fora
        cadeia = [url] if final == url else [url, final]
        return _montar(url, cadeia, html, "", http, "navegador")

    analisados = []
    if validos:
        with ThreadPoolExecutor(max_workers=min(4, len(validos))) as pool:
            analisados = list(pool.map(um, validos))
    bons = [a for a in analisados if a]
    falhos = [u for u, a in zip(validos, analisados) if not a]

    conn = get_db()
    with conn:
        if bons:
            _gravar(conn, bons)
        if falhos:
            # tentou e falhou: marca para a fila deixar de pedir a cada pesquisa
            conn.execute("UPDATE destinos SET lido_por = 'navegador' WHERE url = ANY(%s)",
                         (falhos,))
        if validos:
            lowticket.podar(conn, validos)
    conn.close()
    return {"lidos": len(validos), "aproveitados": len(bons),
            **para_navegador(user_id, 0)}


def processar_lote(limite: int = 8) -> dict:
    """Pega até `limite` destinos pendentes, resolve em paralelo e grava."""
    # Uma conexão por etapa: no psycopg3 o `with conn:` fecha a conexão ao sair,
    # e a parte de rede é lenta demais para segurar uma conexão do Neon parada.
    conn = get_db()
    with conn:
        alvos = conn.execute("""
            UPDATE destinos SET status = 'processando', tentativas = tentativas + 1
            WHERE url IN (
                SELECT url FROM destinos
                WHERE status = 'pendente' AND tentativas < %s
                ORDER BY atualizado_em LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            RETURNING url
        """, (MAX_TENTATIVAS, limite)).fetchall()
    urls = [r["url"] for r in alvos]

    if not urls:
        return {"processados": 0, "pendentes": 0}

    with ThreadPoolExecutor(max_workers=min(6, len(urls))) as pool:
        analisados = list(pool.map(_analisar, urls))

    conn = get_db()
    with conn:
        _gravar(conn, analisados)
        # Site que falhou (timeout, fora do ar) volta para a fila até esgotar as
        # tentativas — antes ficava em 'erro' com 1 tentativa e nunca era refeito.
        conn.execute("""
            UPDATE destinos SET status = 'pendente'
            WHERE status = 'erro' AND tentativas < %s AND url = ANY(%s)
        """, (MAX_TENTATIVAS, urls))
        # Agora que preço e checkout são conhecidos: o que não é low ticket sai.
        podados = lowticket.podar(conn, urls)
        restam = conn.execute(
            "SELECT COUNT(*) AS c FROM destinos WHERE status = 'pendente' AND tentativas < %s",
            (MAX_TENTATIVAS,),
        ).fetchone()["c"]
    conn.close()
    return {"processados": len(urls), "pendentes": restam, "podados": podados}


def reenfileirar(incluir_erros: bool = True) -> int:
    """Volta destinos para a fila (usado pelo botão do painel)."""
    estados = ("processando", "erro") if incluir_erros else ("processando",)
    conn = get_db()
    with conn:
        r = conn.execute(
            "UPDATE destinos SET status='pendente', tentativas=0 WHERE status = ANY(%s)",
            (list(estados),),
        )
    conn.close()
    return r.rowcount
