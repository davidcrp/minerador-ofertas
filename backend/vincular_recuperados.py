"""Liga os favoritos recuperados (page_id `rec:…`) ao anunciante real, quando
ele reaparece no banco depois de uma coleta.

Trocar o retrato remontado pelo de verdade é o que devolve capa, score, preço e
gateway. Quem não reaparecer continua como está.
"""

from __future__ import annotations

import sys
import unicodedata

from psycopg.types.json import Json

from app import montar_ofertas
from db import get_db


def chave(nome: str) -> str:
    """Compara nome sem acento, sem caixa e sem o reticente do truncamento."""
    s = unicodedata.normalize("NFKD", nome or "").encode("ascii", "ignore").decode()
    return s.lower().replace("…", "").strip()


def main() -> int:
    conn = get_db()
    user = conn.execute("SELECT id FROM usuarios ORDER BY id LIMIT 1").fetchone()
    recuperados = conn.execute(
        "SELECT page_id, page_name FROM favoritos WHERE user_id = %s AND page_id LIKE 'rec:%%'",
        (user["id"],)).fetchall()
    conn.close()

    ofertas = montar_ofertas(user["id"], {})
    por_nome = {chave(o["page_name"]): o for o in ofertas}

    ligados, sobraram = [], []
    for r in recuperados:
        alvo = chave(r["page_name"])
        # nome truncado ("Alfabetizando Prof. Fe…") casa por prefixo
        achado = por_nome.get(alvo) or next(
            (o for k, o in por_nome.items() if alvo and k.startswith(alvo[:16])), None)
        (ligados if achado else sobraram).append((r, achado))

    if ligados:
        conn = get_db()
        with conn:
            conn.cursor().executemany("""
                INSERT INTO favoritos (user_id, page_id, page_name, dados, nota)
                VALUES (%s, %s, %s, %s, 'recuperado e revinculado')
                ON CONFLICT (user_id, page_id) DO UPDATE SET dados = EXCLUDED.dados
            """, [(user["id"], str(o["page_id"]), o["page_name"], Json(o))
                  for _, o in ligados])
            conn.execute("DELETE FROM favoritos WHERE user_id = %s AND page_id = ANY(%s)",
                         (user["id"], [r["page_id"] for r, _ in ligados]))
        conn.close()

    for r, o in ligados:
        capa = "com capa" if (o.get("imagem") or o.get("video")) else "sem capa"
        print(f"ligado   {r['page_name'][:28]:<30} -> {o['anuncios_ativos']:>3} ativos ·"
              f" {o['dias_rodando']:>4} dias · {capa}")
    for r, _ in sobraram:
        print(f"sobrou   {r['page_name'][:28]:<30} (não reapareceu na coleta)")
    print(f"\n{len(ligados)} revinculados · {len(sobraram)} ainda recuperados")
    return 0


if __name__ == "__main__":
    sys.exit(main())
