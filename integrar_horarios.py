#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
integrar_horarios.py
Converte horarios_extraidos.json no horarios.json da app, acrescentando o
campo `periodo` (escolar | nao_escolar | anual) e um `tipo_servico` limpo.

Faz backup de horarios.json -> horarios.backup.json antes de substituir.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
EXTRAIDOS = os.path.join(HERE, "horarios_extraidos.json")
HORARIOS = os.path.join(HERE, "horarios.json")
BACKUP = os.path.join(HERE, "horarios.backup.json")

DIA_ORDEM = [
    "segunda_feira", "terca_feira", "quarta_feira", "quinta_feira",
    "sexta_feira", "sabado", "domingo",
]
DIA_SET = set(DIA_ORDEM)


def canonical_tipo(dias):
    """Normaliza o campo `dias` para um tipo_servico canónico."""
    d = (dias or "").strip().lower()
    if d in ("", "dias_uteis", "segunda_a_sexta"):
        return "dias_uteis"
    if d == "todos_os_dias":
        return "todos_os_dias"
    dias_set = {t.strip() for t in re.split(r"\s*\+\s*", d) if t.strip() in DIA_SET}
    if not dias_set:
        return "dias_uteis"
    if dias_set == set(DIA_ORDEM[:5]):
        return "dias_uteis"
    if dias_set == set(DIA_ORDEM):
        return "todos_os_dias"
    return "_".join(x for x in DIA_ORDEM if x in dias_set)


def main():
    with open(EXTRAIDOS, encoding="utf-8") as fh:
        extraidos = json.load(fh)

    servicos = []
    for r in extraidos:
        sentidos = []
        for d in r.get("direcoes", []):
            for p in d.get("periodos", []):
                paragens = [
                    {"nome": x["nome"], "horarios": x["horarios"]}
                    for x in p.get("paragens", [])
                    if x.get("nome")
                ]
                if not paragens:
                    continue
                sentidos.append({
                    "nome": d.get("nome") or "",
                    "tipo_servico": canonical_tipo(p.get("dias")),
                    "periodo": p.get("periodo") or "anual",
                    "paragens": paragens,
                })
        if not sentidos:
            continue
        servicos.append({
            "operador": None,
            "fonte": r.get("fonte"),
            "linha": r.get("linha"),
            "sentidos": sentidos,
        })

    servicos.sort(key=lambda s: s.get("fonte") or "")

    novo = {
        "meta": {
            "gerado_em": datetime.now().astimezone().isoformat(timespec="seconds"),
            "descricao": (
                "Horários extraídos dos PDFs públicos (pdfs_horarios/) via pdfplumber, "
                "com período (escolar/nao_escolar/anual) e tipo_servico normalizado."
            ),
        },
        "servicos": servicos,
    }

    if os.path.exists(HORARIOS):
        shutil.copy2(HORARIOS, BACKUP)
        print(f"Backup criado: {BACKUP}")

    with open(HORARIOS, "w", encoding="utf-8") as fh:
        json.dump(novo, fh, ensure_ascii=False, indent=2)

    n_sentidos = sum(len(s["sentidos"]) for s in servicos)
    print(f"Serviços: {len(servicos)}")
    print(f"Sentidos: {n_sentidos}")
    print(f"Escrito:   {HORARIOS}")


if __name__ == "__main__":
    sys.exit(main())
