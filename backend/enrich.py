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
                      moeda_da_pagina, valor_e_moeda)

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


def _baixar(url: str) -> tuple[list[str], str, str]:
    """Devolve (cadeia_de_urls, html, erro). Só rede — nada de banco aqui,
    porque isso roda em thread."""
    cadeia = [url]
    try:
        r = requests.get(url, headers=HEADERS, timeout=12,
                         allow_redirects=True, stream=True)
        cadeia = [url] + [h.url for h in r.history] + [r.url]
        cadeia = [u for i, u in enumerate(cadeia) if u and u not in cadeia[:i]]

        tipo = (r.headers.get("Content-Type") or "").lower()
        if "html" not in tipo and "text" not in tipo:
            r.close()
            return cadeia, "", ""

        pedacos, total = [], 0
        for pedaco in r.iter_content(chunk_size=16384):
            pedacos.append(pedaco)
            total += len(pedaco)
            if total >= LIMITE_HTML:
                break
        r.close()
        return cadeia, b"".join(pedacos).decode(r.encoding or "utf-8", errors="replace"), ""
    except requests.RequestException as e:
        return cadeia, "", str(e)[:300]


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


def _analisar(url: str) -> tuple:
    cadeia, html, erro = _baixar(url)
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
    preco = achar_preco(texto, final)
    valor, moeda = valor_e_moeda(preco, moeda_da_pagina(texto, final))
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
            "erro" if erro else "ok", erro, url)


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
        cur = conn.cursor()
        resultados = []
        for (jpeg, mime), linha in analisados:
            if jpeg:
                linha = list(linha)
                linha[3] = midias.guardar_capa(cur, midias.chave_site(linha[3]), jpeg, mime)
            resultados.append(linha)
        cur.executemany("""
            UPDATE destinos SET url_final=%s, dominio=%s, titulo_pagina=%s, imagem=%s,
                gateway=%s, gateway_evidencia=%s, checkout_url=%s, preco=%s,
                preco_valor=%s, preco_moeda=%s, whatsapp=%s,
                status=%s, erro=%s, atualizado_em=NOW()
            WHERE url=%s
        """, resultados)
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
