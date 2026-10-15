"""Copia os dados do Neon antigo para o novo.

O banco antigo (compartilhado com o separador-caixa) estourou a cota de
transferência e recusa conexão. Este script fica pronto para o momento em que
ela voltar:

    $env:DB_ANTIGO="postgresql://...antigo..."; $env:DATABASE_URL="postgresql://...novo..."
    python migrar.py            # confere o que dá para trazer
    python migrar.py --aplicar  # copia de verdade

É idempotente: roda de novo sem duplicar (ON CONFLICT DO NOTHING/UPDATE).
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from db import get_db

# Ordem importa: destinos e anunciantes não dependem de ninguém; favoritos
# precisam do usuário, que já existe no banco novo (setup_db.py criou).
TABELAS = {
    "destinos": ("""
        INSERT INTO destinos (url, url_final, dominio, titulo_pagina, imagem, gateway,
            gateway_evidencia, checkout_url, preco, preco_valor, preco_moeda, whatsapp,
            status, erro, tentativas, atualizado_em)
        VALUES (%(url)s, %(url_final)s, %(dominio)s, %(titulo_pagina)s, %(imagem)s,
            %(gateway)s, %(gateway_evidencia)s, %(checkout_url)s, %(preco)s,
            %(preco_valor)s, %(preco_moeda)s, %(whatsapp)s, %(status)s, %(erro)s,
            %(tentativas)s, %(atualizado_em)s)
        ON CONFLICT (url) DO NOTHING
    """, "SELECT * FROM destinos"),

    "anunciantes": ("""
        INSERT INTO anunciantes (page_id, page_name, total_ativos, escaneado_em)
        VALUES (%(page_id)s, %(page_name)s, %(total_ativos)s, %(escaneado_em)s)
        ON CONFLICT (page_id) DO UPDATE SET total_ativos = EXCLUDED.total_ativos
    """, "SELECT * FROM anunciantes"),

    "anuncios": ("""
        INSERT INTO anuncios (user_id, ad_archive_id, page_id, page_name, is_active,
            start_date, end_date, dias_ativo, plataformas, cta_text, link_url, titulo,
            legenda, texto, midia, midia_url, midia_sd, midia_poster, variacoes, termo,
            pais, criado_em, atualizado_em)
        VALUES (%(user_id)s, %(ad_archive_id)s, %(page_id)s, %(page_name)s, %(is_active)s,
            %(start_date)s, %(end_date)s, %(dias_ativo)s, %(plataformas)s, %(cta_text)s,
            %(link_url)s, %(titulo)s, %(legenda)s, %(texto)s, %(midia)s, %(midia_url)s,
            %(midia_sd)s, %(midia_poster)s, %(variacoes)s, %(termo)s, %(pais)s,
            %(criado_em)s, %(atualizado_em)s)
        ON CONFLICT (user_id, ad_archive_id) DO NOTHING
    """, "SELECT * FROM anuncios WHERE excluido_em IS NULL"),

    "favoritos": ("""
        INSERT INTO favoritos (user_id, page_id, page_name, dados, nota, criado_em)
        VALUES (%(user_id)s, %(page_id)s, %(page_name)s, %(dados)s, %(nota)s, %(criado_em)s)
        ON CONFLICT (user_id, page_id) DO UPDATE SET dados = EXCLUDED.dados
    """, "SELECT * FROM favoritos"),
}


def uid_novo() -> int:
    c = get_db()
    r = c.execute("SELECT id FROM usuarios ORDER BY id LIMIT 1").fetchone()
    c.close()
    if not r:
        sys.exit("banco novo sem usuário — rode setup_db.py antes")
    return r["id"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aplicar", action="store_true", help="copia de verdade")
    ap.add_argument("--tabelas", default=",".join(TABELAS),
                    help="quais copiar (padrão: todas)")
    args = ap.parse_args()

    antigo = os.getenv("DB_ANTIGO")
    if not antigo:
        sys.exit("defina DB_ANTIGO com a connection string do banco antigo")

    try:
        origem = psycopg.connect(antigo, row_factory=dict_row, connect_timeout=15)
    except psycopg.OperationalError as e:
        primeira = str(e).split("\n")[0]
        sys.exit(f"banco antigo indisponível: {primeira}\n"
                 "Se falar em 'data transfer quota', a cota ainda não voltou.")

    destino_uid = uid_novo()
    total = 0
    for nome in [t.strip() for t in args.tabelas.split(",") if t.strip()]:
        insercao, leitura = TABELAS[nome]
        linhas = origem.execute(leitura).fetchall()
        print(f"{nome}: {len(linhas)} linha(s) no banco antigo")
        if not args.aplicar or not linhas:
            continue

        for linha in linhas:
            linha.pop("id", None)
            if "user_id" in linha:
                linha["user_id"] = destino_uid        # o id do usuário pode diferir
            if "dados" in linha:
                linha["dados"] = Json(linha["dados"])
            linha.pop("excluido_em", None)

        conn = get_db()
        with conn:
            conn.cursor().executemany(insercao, linhas)
        conn.close()
        total += len(linhas)
        print(f"   copiadas para o banco novo")

    origem.close()
    print(f"\n{'copiado' if args.aplicar else 'seria copiado'}: {total} linha(s)")
    if not args.aplicar:
        print("rode de novo com --aplicar para gravar")
    return 0


if __name__ == "__main__":
    sys.exit(main())
