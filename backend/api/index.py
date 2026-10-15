"""Entrypoint da Vercel. Todo o tráfego cai aqui via rewrite do vercel.json."""

import os
import sys

# A raiz do projeto (onde ficam app.py e templates/) precisa estar no path:
# a Vercel executa este arquivo de dentro de api/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402  (import depois do sys.path é proposital)

# O runtime Python da Vercel procura uma variável WSGI chamada `app`.
application = app
