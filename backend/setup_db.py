"""Cria o esquema no Neon e o usuário único. Rode UMA vez, da sua máquina.

    set DATABASE_URL=postgresql://...        (PowerShell: $env:DATABASE_URL="...")
    set MINERADOR_ADMIN_SENHA=suasenhaforte
    python setup_db.py

Para trocar a senha depois:

    python setup_db.py --senha novasenha
"""

import argparse
import os
import sys

from db import init_db, trocar_senha, url_banco


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--senha", help="troca a senha do usuário existente")
    ap.add_argument("--usuario", default=os.getenv("MINERADOR_ADMIN_USER", "admin"))
    args = ap.parse_args()

    try:
        destino = url_banco().split("@")[-1].split("/")[0]
    except RuntimeError as e:
        print("ERRO:", e)
        return 1
    print(f"banco: {destino}")

    if args.senha:
        ok = trocar_senha(args.usuario, args.senha)
        print("senha trocada" if ok else f"usuário '{args.usuario}' não existe")
        return 0 if ok else 1

    try:
        print(init_db())
    except RuntimeError as e:
        print("ERRO:", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
