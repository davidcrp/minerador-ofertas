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

GATILHOS = {
    "pt": [
        "acesso imediato", "pagamento único", "por apenas", "apenas r$", "r$ 9,90",
        "r$ 19,90", "r$ 27", "r$ 37", "r$ 47", "garantia de 7 dias", "receba no email",
        "download imediato", "acesso vitalício", "oferta por tempo limitado",
        "bônus exclusivos", "material digital", "compra segura", "menos de um lanche",
    ],
    "es": [
        "acceso inmediato", "pago único", "por solo", "solo hoy", "garantía de 7 días",
        "descarga inmediata", "acceso de por vida", "oferta por tiempo limitado",
        "bonos exclusivos", "material digital", "compra segura",
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


def termos_que_renderam(user_id: int, idioma: str = "pt", limite: int = 12) -> list[str]:
    """Termos com mais anunciantes ainda no minerador (= passaram no low ticket),
    só do mesmo mercado: termo que rendeu no Brasil não serve para o México."""
    mercado = "pais IN ('BR', 'PT')" if idioma == "pt" else "pais NOT IN ('BR', 'PT')"
    conn = get_db()
    linhas = conn.execute(f"""
        SELECT termo, COUNT(DISTINCT page_id) AS n FROM anuncios
        WHERE user_id = %s AND excluido_em IS NULL AND COALESCE(termo, '') <> ''
          AND {mercado}
        GROUP BY termo ORDER BY n DESC LIMIT %s
    """, (user_id, limite)).fetchall()
    conn.close()
    return [r["termo"] for r in linhas]


def montar(user_id: int, idioma: str = "pt", hoje: date | None = None) -> dict:
    idioma = "es" if idioma == "es" else "pt"
    hoje = hoje or date.today()
    # Embaralha diferente a cada dia: rodadas seguidas não repetem a mesma ordem.
    sorteio = random.Random(f"{user_id}-{hoje.isoformat()}")

    bons = termos_que_renderam(user_id, idioma)
    sazonais = [t for _, _, termos in ideias.proximas_datas(hoje, idioma, dias=70)
                for t in termos]
    fixos = GATILHOS[idioma] + FORMATOS[idioma]
    sorteio.shuffle(sazonais)
    sorteio.shuffle(fixos)

    grupos = [{"tema": "já renderam", "termos": bons},
              {"tema": "sazonal", "termos": sazonais},
              {"tema": "gatilhos", "termos": fixos}]
    return {"termos": ideias._intercalar_todos(grupos), "renderam": bons}
