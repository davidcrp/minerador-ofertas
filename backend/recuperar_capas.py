"""Recupera capas mortas guardando no banco, comprimido, o que ainda está vivo.

As URLs da CDN da Meta vencem em dias e as de 18/08 morreram em 23/08 sem
cópia nenhuma — essas só voltam coletando o anúncio de novo. O que dá para
salvar agora é a og:image dos destinos: ela vira WebP pequeno na tabela
`capas` e o destino passa a apontar para /capa/<chave>.

    $env:DATABASE_URL="postgresql://..."; python recuperar_capas.py

Também recomprime em WebP as capas antigas que estavam em JPEG.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import midias
from db import get_db, init_db


def _baixar(linha: dict) -> tuple:
    url = linha["imagem"]
    try:
        return (linha["url"], url, *midias.baixar_comprimido(url, referer=linha["url_final"] or ""))
    except Exception as e:
        return (linha["url"], url, b"", str(e)[:80])


def sites() -> None:
    conn = get_db()
    linhas = [dict(r) for r in conn.execute(
        "SELECT url, url_final, imagem FROM destinos WHERE imagem LIKE 'http%%'").fetchall()]
    conn.close()
    print(f"{len(linhas)} og:image externas")

    with ThreadPoolExecutor(max_workers=8) as pool:
        resultados = list(pool.map(_baixar, linhas))

    ok = falhas = total = 0
    conn = get_db()
    with conn:
        cur = conn.cursor()
        for url, imagem, dados, mime in resultados:
            if not dados:
                falhas += 1
                continue
            local = midias.guardar_capa(cur, midias.chave_site(imagem), dados, mime)
            cur.execute("UPDATE destinos SET imagem = %s WHERE url = %s", (local, url))
            ok += 1
            total += len(dados)
    conn.close()
    print(f"guardadas {ok} ({total / 1024:.0f} KB), falharam {falhas}")


def recomprimir() -> None:
    conn = get_db()
    linhas = conn.execute(
        "SELECT ad_archive_id, jpeg, bytes FROM capas WHERE mime IS DISTINCT FROM 'image/webp'"
    ).fetchall()
    antes = depois = 0
    with conn:
        cur = conn.cursor()
        for r in linhas:
            dados, mime = midias.comprimir(bytes(r["jpeg"]))
            if dados and len(dados) < (r["bytes"] or len(r["jpeg"])):
                midias.guardar_capa(cur, r["ad_archive_id"], dados, mime)
                antes += r["bytes"] or 0
                depois += len(dados)
    conn.close()
    print(f"recomprimidas {len(linhas)} capas: {antes / 1024:.0f} KB -> {depois / 1024:.0f} KB")


if __name__ == "__main__":
    print(init_db())          # aplica a coluna `mime` de capas
    recomprimir()
    sites()
