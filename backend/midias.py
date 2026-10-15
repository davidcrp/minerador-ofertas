"""Baixa a mídia do anúncio da CDN da Meta e guarda no Vercel Blob.

Por que copiar em vez de apontar direto: a URL que a Biblioteca entrega é
assinada e expira em poucas horas (`oe=` no query string). Guardar a URL crua
significa capa quebrada no dia seguinte — foi o que acontecia com os anúncios
em vídeo, que ainda por cima caíam num <img> com .mp4 dentro.

Mesmo desenho do enrich.py: serverless não tem worker de fundo, então o
trabalho sai em lotes puxados por quem chama `/api/midias`.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

import requests

from db import get_db

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

BLOB_API = "https://blob.vercel-storage.com"
MAX_TENTATIVAS = 3

# SD em vez de HD: a capa é um quadrado de 230px, e HD multiplicaria por 5 o
# armazenamento sem diferença visível.
MAX_VIDEO = 12 * 1024 * 1024
MAX_POSTER = 3 * 1024 * 1024

# Teto do armazenamento no Blob. O plano dá 1 GB; estourar não dá erro claro —
# o Blob passa a responder 403 no upload e as capas somem do painel sem motivo
# aparente. Então guardamos folga e limpamos sozinhos antes de chegar lá.
MAX_BYTES_GUARDADOS = int(os.getenv("MINERADOR_MAX_BYTES", str(250 * 1024 * 1024)))
LIMITE_LIMPEZA = int(os.getenv("MINERADOR_LIMITE_BLOB", str(700 * 1024 * 1024)))
ALVO_LIMPEZA = int(os.getenv("MINERADOR_ALVO_BLOB", str(450 * 1024 * 1024)))

def token() -> str:
    t = os.getenv("BLOB_READ_WRITE_TOKEN")
    if not t:
        raise RuntimeError("BLOB_READ_WRITE_TOKEN não definido (conecte o Blob store ao projeto)")
    return t


def _baixar(url: str, limite: int, referer: str = "https://www.facebook.com/") -> bytes:
    # Sem Referer do facebook.com a CDN devolve 403 em parte dos arquivos.
    cab = {"User-Agent": UA, "Accept": "*/*"}
    if referer:
        cab["Referer"] = referer
    r = requests.get(url, headers=cab,
                     timeout=20, stream=True)
    r.raise_for_status()
    pedacos, total = [], 0
    for pedaco in r.iter_content(chunk_size=65536):
        pedacos.append(pedaco)
        total += len(pedaco)
        if total > limite:
            r.close()
            raise ValueError(f"arquivo maior que o limite ({limite} bytes)")
    r.close()
    return b"".join(pedacos)


def _encolher(dados: bytes) -> bytes:
    """Capa para o Blob: mesma compressão da que vai para o banco."""
    return comprimir(dados)[0] or dados


def apagar_blobs(urls) -> int:
    """Remove arquivos do Blob. Usado pela limpeza automática."""
    urls = [u for u in urls if u]
    if not urls:
        return 0
    r = requests.post(f"{BLOB_API}/delete",
                      json={"urls": urls},
                      headers={"authorization": f"Bearer {token()}", "x-api-version": "7"},
                      timeout=40)
    r.raise_for_status()
    return len(urls)


def limpar(alvo: int = ALVO_LIMPEZA) -> dict:
    """Apaga do Blob até caber em `alvo` bytes. Vídeo sai primeiro (é o que pesa)
    e do mais antigo para o mais novo; capa de anunciante salvo em Melhores fica
    por último na fila de descarte."""
    conn = get_db()
    total = conn.execute("SELECT COALESCE(SUM(bytes),0) AS b FROM midias WHERE status='ok'"
                         ).fetchone()["b"] or 0
    if total <= alvo:
        conn.close()
        return {"apagados": 0, "mb": round(total / 1048576, 1)}

    candidatos = conn.execute("""
        SELECT m.ad_archive_id, m.video_url, m.poster_url, m.bytes
        FROM midias m
        LEFT JOIN anuncios a ON a.ad_archive_id = m.ad_archive_id
        LEFT JOIN favoritos f ON f.page_id = a.page_id
        WHERE m.status = 'ok' AND m.video_url <> ''
        ORDER BY (f.id IS NOT NULL), m.atualizado_em
    """).fetchall()
    conn.close()

    apagados, liberado = [], 0
    for c in candidatos:
        if total - liberado <= alvo:
            break
        apagados.append(c)
        liberado += c["bytes"] or 0

    for c in apagados:
        try:
            apagar_blobs([c["video_url"]])
        except Exception as e:
            print("falha ao apagar", c["ad_archive_id"], e)

    if apagados:
        conn = get_db()
        with conn:
            conn.cursor().executemany(
                "UPDATE midias SET video_url='', bytes=GREATEST(0, bytes - %s) WHERE ad_archive_id=%s",
                [(c["bytes"] or 0, c["ad_archive_id"]) for c in apagados])
        conn.close()
    return {"apagados": len(apagados), "mb": round((total - liberado) / 1048576, 1)}


def _subir(caminho: str, dados: bytes, tipo: str) -> str:
    r = requests.put(
        f"{BLOB_API}/{caminho}",
        data=dados,
        headers={
            "authorization": f"Bearer {token()}",
            "x-api-version": "7",
            "x-content-type": tipo,
            "x-add-random-suffix": "0",          # mesmo anúncio, mesmo caminho
            "x-cache-control-max-age": "31536000",
        },
        timeout=40,
    )
    r.raise_for_status()
    return r.json()["url"]


def registrar(ads) -> int:
    """Enfileira a mídia dos anúncios recebidos. `ads` são dicts normalizados."""
    linhas = []
    for a in ads:
        aid = str(a.get("ad_archive_id") or "")
        origem = (a.get("midia_sd") or a.get("midia_url") or "").strip()
        poster = (a.get("midia_poster") or "").strip()
        if not aid or not (origem.startswith("http") or poster.startswith("http")):
            continue
        linhas.append((aid, (a.get("midia") or "")[:40], origem[:2000], poster[:2000]))
    if not linhas:
        return 0

    conn = get_db()
    with conn:
        # URL nova de um anúncio que falhou volta para a fila: a assinatura
        # antiga tinha expirado, esta é fresca.
        conn.cursor().executemany("""
            INSERT INTO midias (ad_archive_id, tipo, origem, origem_poster, status)
            VALUES (%s, %s, %s, %s, 'pendente')
            ON CONFLICT (ad_archive_id) DO UPDATE SET
                origem = EXCLUDED.origem,
                origem_poster = EXCLUDED.origem_poster,
                status = CASE WHEN midias.status = 'ok' THEN 'ok' ELSE 'pendente' END,
                tentativas = CASE WHEN midias.status = 'ok' THEN midias.tentativas ELSE 0 END
        """, linhas)
    conn.close()
    return len(linhas)


def pendentes() -> int:
    conn = get_db()
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM midias WHERE status = 'pendente' AND tentativas < %s",
        (MAX_TENTATIVAS,)).fetchone()["c"]
    conn.close()
    return n


def _processar(linha: dict) -> tuple:
    """Só rede — roda em thread, não encosta no banco."""
    aid = linha["ad_archive_id"]
    video_url = poster_url = ""
    bytes_total = 0
    erro = ""

    # Anúncio de imagem não tem "poster" separado: a capa é a própria mídia.
    fonte_capa = linha["origem_poster"] or ("" if linha["tipo"] == "video" else linha["origem"])

    if fonte_capa:
        try:
            dados = _encolher(_baixar(fonte_capa, MAX_POSTER))
            poster_url = _subir(f"anuncios/{aid}/capa.webp", dados, "image/webp")
            bytes_total += len(dados)
        except Exception as e:
            erro = f"poster: {str(e)[:120]}"

    if linha["tipo"] == "video" and linha["origem"]:
        try:
            dados = _baixar(linha["origem"], MAX_VIDEO)
            video_url = _subir(f"anuncios/{aid}/video.mp4", dados, "video/mp4")
            bytes_total += len(dados)
        except Exception as e:
            erro = (erro + " | " if erro else "") + f"video: {str(e)[:120]}"

    ok = bool(video_url or poster_url)
    if not ok and not erro:
        # anúncio antigo, gravado antes de a extensão capturar poster/sd
        erro = "sem URL de mídia utilizável"
    return (video_url, poster_url, bytes_total, "ok" if ok else "erro", erro[:300], aid)


BLOB_ATIVO = os.getenv("MINERADOR_BLOB", "1") != "0"


# Toda imagem que entra (criativo do anúncio, og:image do site) passa por
# `comprimir` antes de ir para o banco. WebP de 320px a q50 cobre o quadrado de
# 280 do painel e pesa 3-4x menos que o JPEG de 400px a q72 que usávamos
# (medido em og:image reais: 15 KB -> 5 KB, 46 KB -> 21 KB).
LARGURA_MINI = 320
QUALIDADE_MINI = 50
# Teto de download, não de armazenamento: og:image de loja chega a 3 MB e sai
# com 5 KB depois de comprimida.
MAX_ORIGINAL = 10 * 1024 * 1024
MAX_CAPAS_BYTES = int(os.getenv("MINERADOR_MAX_CAPAS", str(120 * 1024 * 1024)))


def comprimir(dados: bytes) -> tuple[bytes, str]:
    """(bytes, mime) da miniatura WebP. Devolve (b"", "") se não for imagem —
    página de erro em HTML não pode virar "capa" no banco."""
    import io

    from PIL import Image, ImageOps
    try:
        img = Image.open(io.BytesIO(dados))
        img.seek(0)                      # GIF/WebP animado: só o primeiro quadro
        img = ImageOps.exif_transpose(img)
        img.thumbnail((LARGURA_MINI, LARGURA_MINI * 3), Image.LANCZOS)
        img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
        saida = io.BytesIO()
        img.save(saida, format="WEBP", quality=QUALIDADE_MINI, method=6)
        return saida.getvalue(), "image/webp"
    except Exception:
        return b"", ""


def baixar_comprimido(url: str, referer: str = "https://www.facebook.com/") -> tuple[bytes, str]:
    """Só rede: baixa e comprime. Lança exceção se o download falhar."""
    dados = _baixar(url, MAX_ORIGINAL, referer)
    mini, mime = comprimir(dados)
    if not mini:
        raise ValueError("não é imagem")
    return mini, mime


def guardar_capa(cur, chave: str, dados: bytes, mime: str) -> str:
    cur.execute("""
        INSERT INTO capas (ad_archive_id, jpeg, bytes, mime) VALUES (%s, %s, %s, %s)
        ON CONFLICT (ad_archive_id) DO UPDATE
           SET jpeg = EXCLUDED.jpeg, bytes = EXCLUDED.bytes, mime = EXCLUDED.mime,
               criado_em = NOW()
    """, (chave, dados, len(dados), mime))
    return f"/capa/{chave}"


def chave_site(url: str) -> str:
    """Chave da og:image na tabela `capas` (ao lado das capas por anúncio)."""
    import hashlib
    return "s" + hashlib.sha1(url.encode()).hexdigest()[:32]


def _baixar_mini(linha: dict) -> tuple:
    """Só rede: baixa a capa e devolve a miniatura. Vídeo fica de fora — no
    banco ele custaria centenas de vezes a miniatura pelo mesmo quadro parado."""
    aid = linha["ad_archive_id"]
    fonte = linha["origem_poster"] or ("" if linha["tipo"] == "video" else linha["origem"])
    if not fonte:
        return (aid, b"", "", "sem URL de capa")
    try:
        return (aid, *baixar_comprimido(fonte), "")
    except Exception as e:
        # 403 aqui é URL assinada que já venceu: só a próxima coleta resolve
        return (aid, b"", "", f"capa: {str(e)[:120]}")


def _lote_no_banco(limite: int) -> dict:
    """Mesmo lote do Blob, guardando a miniatura na tabela `capas`."""
    conn = get_db()
    with conn:
        guardados = conn.execute(
            "SELECT COALESCE(SUM(bytes), 0) AS b FROM capas").fetchone()["b"]
        alvos = conn.execute("""
            UPDATE midias SET status = 'processando', tentativas = tentativas + 1
            WHERE ad_archive_id IN (
                SELECT ad_archive_id FROM midias
                WHERE status = 'pendente' AND tentativas < %s
                ORDER BY atualizado_em DESC LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            RETURNING ad_archive_id, tipo, origem, origem_poster
        """, (MAX_TENTATIVAS, limite)).fetchall()

    if not alvos or guardados >= MAX_CAPAS_BYTES:
        conn.close()
        return {"processados": 0, "pendentes": 0, "onde": "banco",
                "mb_guardados": round(guardados / 1048576, 1),
                "cheio": guardados >= MAX_CAPAS_BYTES}

    linhas = [dict(r) for r in alvos]
    with ThreadPoolExecutor(max_workers=min(8, len(linhas))) as pool:
        resultados = list(pool.map(_baixar_mini, linhas))

    conn = get_db()
    with conn:
        cur = conn.cursor()
        for aid, jpeg, mime, erro in resultados:
            if jpeg:
                guardar_capa(cur, aid, jpeg, mime)
            cur.execute("""
                UPDATE midias SET poster_url = %s, bytes = %s, status = %s, erro = %s,
                    atualizado_em = NOW()
                WHERE ad_archive_id = %s
            """, (f"/capa/{aid}" if jpeg else "", len(jpeg),
                  "ok" if jpeg else "erro", erro[:300], aid))
        restam = conn.execute(
            "SELECT COUNT(*) AS c FROM midias WHERE status = 'pendente' AND tentativas < %s",
            (MAX_TENTATIVAS,)).fetchone()["c"]
    conn.close()
    feitas = sum(1 for r in resultados if r[1])
    return {"processados": len(linhas), "guardadas": feitas, "pendentes": restam,
            "onde": "banco",
            "mb_guardados": round((guardados + sum(len(r[1]) for r in resultados)) / 1048576, 1)}


def processar_lote(limite: int = 3) -> dict:
    """Baixa e sobe até `limite` mídias. Devolve quantas faltam."""
    if not BLOB_ATIVO:
        # Store suspenso por cota. Em vez de desistir da capa (o painel ficava
        # só com quadro vazio depois que a URL da Meta vencia), a miniatura vai
        # para o Postgres, que é o armazenamento que ainda temos de pé.
        return _lote_no_banco(max(1, min(limite * 2, 12)))
    limite = max(1, min(limite, 6))
    # Chegou perto da cota: libera espaço antes de tentar subir, senão o Blob
    # responde 403 e o lote inteiro se perde.
    conn = get_db()
    total = conn.execute("SELECT COALESCE(SUM(bytes),0) AS b FROM midias WHERE status='ok'"
                         ).fetchone()["b"] or 0
    conn.close()
    if total >= LIMITE_LIMPEZA:
        limpar()

    conn = get_db()
    with conn:
        guardados = conn.execute(
            "SELECT COALESCE(SUM(bytes), 0) AS b FROM midias WHERE status = 'ok'"
        ).fetchone()["b"]
        alvos = conn.execute("""
            UPDATE midias SET status = 'processando', tentativas = tentativas + 1
            WHERE ad_archive_id IN (
                SELECT ad_archive_id FROM midias
                WHERE status = 'pendente' AND tentativas < %s
                -- mais novo primeiro: a assinatura da URL expira, então o que
                -- acabou de ser coletado é o que ainda dá para baixar
                ORDER BY atualizado_em DESC LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            RETURNING ad_archive_id, tipo, origem, origem_poster
        """, (MAX_TENTATIVAS, limite)).fetchall()

    if not alvos:
        return {"processados": 0, "pendentes": 0, "mb_guardados": round(guardados / 1048576, 1)}

    linhas = [dict(r) for r in alvos]
    # Estourou o teto: continua guardando a capa, larga o vídeo.
    if guardados >= MAX_BYTES_GUARDADOS:
        for linha in linhas:
            linha["tipo"] = "imagem"

    with ThreadPoolExecutor(max_workers=min(3, len(linhas))) as pool:
        resultados = list(pool.map(_processar, linhas))

    conn = get_db()
    with conn:
        conn.cursor().executemany("""
            UPDATE midias SET video_url=%s, poster_url=%s, bytes=%s, status=%s, erro=%s,
                atualizado_em=NOW()
            WHERE ad_archive_id=%s
        """, resultados)
        restam = conn.execute(
            "SELECT COUNT(*) AS c FROM midias WHERE status = 'pendente' AND tentativas < %s",
            (MAX_TENTATIVAS,)).fetchone()["c"]
    conn.close()
    return {"processados": len(linhas), "pendentes": restam,
            "mb_guardados": round((guardados + sum(r[2] for r in resultados)) / 1048576, 1)}


def processar_ate(segundos: float = 20) -> dict:
    """Mói a fila de capas até acabar ou estourar o prazo. Chamado logo depois
    da coleta: a URL da Meta vence em poucos dias e esperar o painel abrir foi
    o que deixou 1.954 capas sem cópia nenhuma."""
    import time
    fim = time.monotonic() + segundos
    feitas = 0
    r = {"pendentes": 0}
    while time.monotonic() < fim:
        r = processar_lote(6)
        feitas += r.get("guardadas", 0)
        if not r.get("processados") or not r.get("pendentes") or r.get("cheio"):
            break
    return {"guardadas": feitas, "pendentes": r.get("pendentes", 0)}


def registrar_do_banco(limite: int = 500) -> int:
    """Enfileira a mídia dos anúncios que já estavam no banco. URL antiga pode
    ter expirado — aí a tentativa falha e só a próxima coleta resolve."""
    conn = get_db()
    with conn:
        n = conn.execute("""
            INSERT INTO midias (ad_archive_id, tipo, origem, origem_poster, status)
            SELECT DISTINCT ON (a.ad_archive_id)
                   a.ad_archive_id, a.midia,
                   COALESCE(NULLIF(a.midia_sd, ''), a.midia_url, ''),
                   COALESCE(a.midia_poster, '')
                   , 'pendente'
            FROM anuncios a
            LEFT JOIN midias m ON m.ad_archive_id = a.ad_archive_id
            WHERE m.ad_archive_id IS NULL
              AND (a.midia_url LIKE 'http%%' OR a.midia_sd LIKE 'http%%'
                   OR a.midia_poster LIKE 'http%%')
            ORDER BY a.ad_archive_id, a.atualizado_em DESC
            LIMIT %s
            ON CONFLICT (ad_archive_id) DO NOTHING
        """, (limite,)).rowcount
    conn.close()
    return n


def reenfileirar() -> int:
    conn = get_db()
    with conn:
        r = conn.execute("UPDATE midias SET status='pendente', tentativas=0"
                         " WHERE status IN ('processando', 'erro')")
    conn.close()
    return r.rowcount
