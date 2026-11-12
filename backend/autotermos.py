"""Palavras-chave da mineração automática.

A busca da Biblioteca casa com o texto do anúncio, e anúncio low ticket se
denuncia pela copy: "acesso imediato", "pagamento único", "por apenas R$ 19,90",
"ebook", "moldes". A lista mistura três fontes, intercaladas:

1. termos que JÁ renderam low ticket neste minerador (aprende com o uso);
2. datas comerciais dos próximos ~2 meses (calendário de ideias.py);
3. gatilhos e formatos fixos de oferta de entrada.

Fica no servidor de propósito: melhorar a lista não exige reinstalar a extensão.
"""

from __future__ import annotations

import random
from datetime import date

import ideias
from db import get_db

# Gatilho de copy vai entre aspas: a extensão busca a FRASE EXATA. Sem aspas a
# Biblioteca casa as palavras soltas, em qualquer ordem — "por apenas" trazia
# qualquer anúncio com "por" e "apenas", e a busca voltava cheia de loja e
# serviço local em vez de oferta de entrada.
GATILHOS = {
    "pt": [
        '"acesso imediato"', '"pagamento único"', '"por apenas r$"', '"apenas r$"',
        '"r$ 9,90"', '"r$ 10"', '"r$ 14,90"', '"r$ 19,90"', '"r$ 27"', '"r$ 29,90"',
        '"r$ 37"', '"r$ 47"', '"garantia de 7 dias"', '"receba no email"',
        '"receba no whatsapp"', '"download imediato"', '"acesso vitalício"',
        '"oferta por tempo limitado"', '"bônus exclusivos"', '"material digital"',
        '"compra segura"', '"menos de um lanche"', '"preço de um café"',
        '"arquivo digital"', '"pronto para imprimir"', '"100% editável"',
        '"de r$ 97 por"', '"de r$ 67 por"', '"últimas vagas com desconto"',
    ],
    "es": [
        '"acceso inmediato"', '"pago único"', '"por solo"', '"solo hoy"',
        '"garantía de 7 días"', '"descarga inmediata"', '"acceso de por vida"',
        '"oferta por tiempo limitado"', '"bonos exclusivos"', '"material digital"',
        '"compra segura"', '"listo para imprimir"', '"100% editable"',
        '"recíbelo en tu correo"', '"menos que un café"',
    ],
}
FORMATOS = {
    "pt": [
        "ebook", "pdf", "apostila", "kit digital", "pack", "moldes", "planner",
        "atividades para imprimir", "receitas", "guia completo", "mini curso",
        "passo a passo", "templates canva", "artes editáveis", "planilha",
        "método", "desafio 21 dias", "renda extra", "livro de colorir", "combo digital",
    ],
    "es": [
        "ebook", "pdf", "kit digital", "pack", "moldes", "planner", "plantillas",
        "recetario", "guía completa", "mini curso", "paso a paso", "plantillas canva",
        "actividades para imprimir", "ingresos extra", "método", "libro para colorear",
    ],
}


def desempenho_dos_termos(user_id: int, idioma: str = "pt") -> tuple[list[str], set[str]]:
    """(bons, ruins) dos últimos 60 dias, só do mesmo mercado — termo que
    rendeu no Brasil não serve para o México.

    Rendimento = anunciantes que PASSARAM no low ticket (destino lido, com
    preço, ainda no minerador) por busca feita. Antes a conta era "anunciantes
    ainda no banco", que premiava termo recém-buscado (ninguém tinha sido
    podado ainda) e nunca aposentava termo que só traz lixo.

    - bons: maior rendimento primeiro;
    - ruins: buscado 2+ vezes e nenhum anunciante aprovado — sai da fila até
      as buscas dele envelhecerem."""
    mercado = "IN ('BR', 'PT')" if idioma == "pt" else "NOT IN ('BR', 'PT')"
    conn = get_db()
    buscas = {r["termo"]: r["n"] for r in conn.execute(f"""
        SELECT LOWER(termo) AS termo, COUNT(*) AS n FROM pesquisas
        WHERE user_id = %s AND criado_em > NOW() - INTERVAL '60 days'
          AND COALESCE(termo, '') <> '' AND pais {mercado}
        GROUP BY LOWER(termo)
    """, (user_id,)).fetchall()}
    aprovados = {r["termo"]: r["n"] for r in conn.execute(f"""
        SELECT LOWER(a.termo) AS termo, COUNT(DISTINCT a.page_id) AS n
        FROM anuncios a JOIN destinos d ON d.url = a.link_url
        WHERE a.user_id = %s AND a.excluido_em IS NULL AND COALESCE(a.termo, '') <> ''
          AND a.pais {mercado} AND d.status = 'ok' AND d.preco_valor > 0
        GROUP BY LOWER(a.termo)
    """, (user_id,)).fetchall()}
    conn.close()

    bons = sorted(aprovados, key=lambda t: (-aprovados[t] / max(1, buscas.get(t, 1)),
                                            -aprovados[t]))[:15]
    ruins = {t for t, n in buscas.items() if n >= 2 and not aprovados.get(t)}
    return bons, ruins


def montar(user_id: int, idioma: str = "pt", hoje: date | None = None) -> dict:
    idioma = "es" if idioma == "es" else "pt"
    hoje = hoje or date.today()
    # Embaralha diferente a cada dia: rodadas seguidas não repetem a mesma ordem.
    sorteio = random.Random(f"{user_id}-{hoje.isoformat()}")

    bons, ruins = desempenho_dos_termos(user_id, idioma)
    serve = lambda t: t.lower() not in ruins                        # noqa: E731
    sazonais = [t for _, _, termos in ideias.proximas_datas(hoje, idioma, dias=70)
                for t in termos if serve(t)]
    fixos = [t for t in GATILHOS[idioma] + FORMATOS[idioma] if serve(t)]
    sorteio.shuffle(sazonais)
    sorteio.shuffle(fixos)

    grupos = [{"tema": "já renderam", "termos": bons},
              {"tema": "sazonal", "termos": sazonais},
              {"tema": "gatilhos", "termos": fixos}]
    return {"termos": ideias._intercalar_todos(grupos), "renderam": bons,
            "aposentados": sorted(ruins)}
