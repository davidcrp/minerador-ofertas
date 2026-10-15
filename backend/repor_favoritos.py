"""Repõe no banco novo os favoritos remontados dos diagnósticos.

São retratos parciais: nome, destino conhecido e o que foi observado. Entram com
page_id sintético `rec:<slug>` e a marca `recuperado`, para o painel mostrar que
ali não há métrica — e para a migração de verdade (migrar.py) poder substituí-los
sem duplicar quando a cota do banco antigo voltar.
"""

from __future__ import annotations

import re
import sys
from urllib.parse import quote_plus

from psycopg.types.json import Json

from db import get_db

# (nome, destino, dominio, observação)
FAVORITOS = [
    ("TIVIT", "https://tivit.com", "tivit.com", "28 ativos · 341 dias · termo \"dinamicas\""),
    ("Profª Juliana Gamon", "https://saeb.profjulianagamon.online",
     "saeb.profjulianagamon.online", "Lastlink · R$ 15 · 60 ativos · 75 dias"),
    ("Biblioteca del Funcional", "https://bibliotecadofuncional.lovable.app",
     "bibliotecadofuncional.lovable.app", "R$ 10,00 · 16 ativos · 18 dias"),
    ("Mariana Alves", "https://atividades.guiapractico.com/",
     "atividades.guiapractico.com", ""),
    ("Alfabetizando Prof. Fe…", "https://alfabetizandooficial.com",
     "alfabetizandooficial.com", "nome truncado no diagnóstico"),
    ("Ponto da Fé", "https://rotinademae.online/kit-novena-certa/",
     "rotinademae.online", ""),
    ("Casos e Enigmas", "https://casos-e-enigmas.pages.dev/",
     "casos-e-enigmas.pages.dev", ""),
    ("Radar Concursos", "https://pmes.radarconcursos.online/",
     "pmes.radarconcursos.online", ""),
    ("Leiturinhas da Manu", "https://api.whatsapp.com/send", "api.whatsapp.com", ""),
    ("Tejiendo Con Magia", "", "", ""),
    ("Teje con amor", "", "", ""),
    ("Luciana Oliveiraa", "", "", ""),
    ("Universo Cristão", "", "", ""),
    ("Daniele Rios", "", "", ""),
    ("Alegria da Fé", "", "", ""),
    ("Fátima Maria", "", "", ""),
    ("PlayAula", "", "", ""),
]


def slug(nome: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-")[:40]


def busca_na_biblioteca(nome: str) -> str:
    """Sem page_id, o link vira uma busca pelo nome — que é como reencontrá-lo."""
    return ("https://www.facebook.com/ads/library/?active_status=active&ad_type=all"
            "&country=BR&media_type=all&search_type=keyword_unordered"
            f"&q={quote_plus(nome)}")


def retrato(nome: str, destino: str, dominio: str, obs: str) -> dict:
    return {
        "page_id": f"rec:{slug(nome)}",
        "page_name": nome,
        "anuncios_ativos": 0, "contagem_real": False, "anuncios_coletados": 0,
        "variacoes": 0, "dias_rodando": 0, "dias_novo": 0, "primeiro_anuncio": "",
        "dominio": dominio, "destino": destino, "gateway": "", "tipo_gateway": "",
        "checkout_url": "", "imagem": "", "imagem_do_site": False, "video": "",
        "poster": "", "preco": "", "preco_valor": 0, "moeda": "",
        "termos": [], "paises": [], "plataformas": [], "cta": [],
        "copy": obs or "Favorito recuperado — sem métricas até a próxima coleta.",
        "pendente": False, "destino_venda": bool(dominio), "score": 0,
        "url_biblioteca": busca_na_biblioteca(nome),
        "recuperado": True,
    }


def main() -> int:
    conn = get_db()
    user = conn.execute("SELECT id FROM usuarios ORDER BY id LIMIT 1").fetchone()
    conn.close()
    if not user:
        sys.exit("banco sem usuário — rode setup_db.py antes")

    linhas = [(user["id"], d["page_id"], nome, Json(d),
               "recuperado do banco antigo")
              for nome, destino, dominio, obs in FAVORITOS
              for d in [retrato(nome, destino, dominio, obs)]]

    conn = get_db()
    with conn:
        conn.cursor().executemany("""
            INSERT INTO favoritos (user_id, page_id, page_name, dados, nota)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (user_id, page_id) DO UPDATE SET dados = EXCLUDED.dados
        """, linhas)
        total = conn.execute("SELECT COUNT(*) AS n FROM favoritos WHERE user_id = %s",
                             (user["id"],)).fetchone()["n"]
    conn.close()
    print(f"{len(linhas)} favoritos repostos · {total} no total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
