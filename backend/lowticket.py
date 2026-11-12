"""Regra única de low ticket: o minerador só guarda oferta de entrada.

Preço e checkout só se sabem depois de visitar o destino (enrich.py), então o
corte acontece em dois momentos:

- na ingestão, sai na hora o que nunca vai ser low ticket (sem link, app,
  perfil, WhatsApp) e o que tem destino já analisado e reprovado;
- depois de cada lote de enriquecimento, sai o que acabou de ser reprovado.

"Sair" é `excluido_em` — o mesmo ✕ reversível do painel. Melhores não é tocado.
"""

from __future__ import annotations

import os

from gateways import IGNORAR, host, tipo_de

# Low ticket se mede em real: US$ 49 não é oferta de entrada no Brasil.
# Cotação fixa e redonda de propósito — o corte é grosso, não contábil.
# As moedas hispânicas precisam estar aqui: moeda fora da tabela vale 0, e com
# isso TODA oferta do México, Argentina, Colômbia, Chile, Peru e Uruguai era
# reprovada ("preço 0") e sumia do minerador.
COTACAO_BRL = {"": 1.0, "BRL": 1.0, "USD": 5.5, "EUR": 6.0,
               "MXN": 0.30, "ARS": 0.004, "COP": 0.0014, "CLP": 0.006,
               "PEN": 1.5, "UYU": 0.14}
# MINERADOR_LOW_MAX muda o teto sem mexer no código (ex.: 97).
LOW_TICKET_MAX = float(os.getenv("MINERADOR_LOW_MAX", "50") or 50)

# Destino que não é página de venda: perfil, conversa, loja de app.
NAO_VENDE = IGNORAR | {"apps.apple.com", "play.google.com", "fb.me", "linktr.ee",
                       "beacons.ai", "bio.link", "linkr.bio", "itunes.apple.com",
                       "m.me", "web.whatsapp.com"}

# Encurtador e redirecionador levam a página de venda: só dá para julgar depois
# de seguir o link, então não podem cair no corte de entrada.
REDIRECIONA = {"bit.ly", "t.co", "l.facebook.com", "lm.facebook.com"}

MAX_TENTATIVAS = 3   # mesmo teto do enrich: destino que esgotou não volta


def link_pode_ser_low(link: str) -> bool:
    """Antes de visitar o site: só descarta o que com certeza não vende."""
    link = (link or "").strip()
    h = host(link)
    return link.startswith("http") and (h in REDIRECIONA or h not in NAO_VENDE)


def preco_brl(valor, moeda: str) -> float:
    return float(valor or 0) * COTACAO_BRL.get(moeda or "", 0)


def destino_e_low(d: dict) -> bool:
    """Destino já analisado: até R$ 50, com checkout, num site que vende."""
    if host(d.get("url_final") or d.get("url") or "") in NAO_VENDE:
        return False
    if not 0 < preco_brl(d.get("preco_valor"), d.get("preco_moeda")) <= LOW_TICKET_MAX:
        return False
    return bool(d.get("checkout_url")) or tipo_de(d.get("gateway") or "") in ("infoproduto",
                                                                          "ecommerce")


def podar(conn, urls=None) -> int:
    """Esconde os anúncios cujo destino já foi decidido e não é low ticket.
    `urls=None` passa o pente no banco inteiro."""
    filtro, args = "", [MAX_TENTATIVAS]
    if urls is not None:
        urls = [u for u in urls if u]
        if not urls:
            return 0
        filtro, args = " AND url = ANY(%s)", [MAX_TENTATIVAS, urls]
    # Decidido = analisado com sucesso, ou esgotou as tentativas (site fora do
    # ar não dá para provar preço nem checkout). 'bloqueado' (403, desafio
    # anti-robô) NÃO é decidido: o site existe, só não deixou o servidor ler —
    # esconder isso jogava fora justamente quem se protege de espião.
    linhas = conn.execute(f"""
        SELECT url, url_final, preco_valor, preco_moeda, checkout_url, gateway
        FROM destinos
        WHERE (status = 'ok' OR (status = 'erro' AND tentativas >= %s)){filtro}
    """, args).fetchall()
    reprovados = [r["url"] for r in linhas if not destino_e_low(dict(r))]
    aprovados = [r["url"] for r in linhas if destino_e_low(dict(r))]

    n = 0
    if reprovados:
        n += conn.execute("""
            UPDATE anuncios SET excluido_em = NOW(), excluido_motivo = 'poda'
            WHERE excluido_em IS NULL AND link_url = ANY(%s)
        """, (reprovados,)).rowcount
    # Destino que passou numa leitura melhor (navegador, checkout, copy) traz
    # de volta o que a poda tinha escondido. O ✕ manual não volta sozinho.
    if aprovados:
        conn.execute("""
            UPDATE anuncios SET excluido_em = NULL, excluido_motivo = NULL
            WHERE excluido_motivo = 'poda' AND link_url = ANY(%s)
        """, (aprovados,))
    if urls is None:
        # sobra de antes da regra: anúncio sem link ou com link de app/perfil
        for r in conn.execute("SELECT DISTINCT link_url FROM anuncios WHERE excluido_em IS NULL"
                              ).fetchall():
            if not link_pode_ser_low(r["link_url"]):
                n += conn.execute("""
                    UPDATE anuncios SET excluido_em = NOW(), excluido_motivo = 'poda'
                    WHERE excluido_em IS NULL AND link_url IS NOT DISTINCT FROM %s
                """, (r["link_url"],)).rowcount
    return n
