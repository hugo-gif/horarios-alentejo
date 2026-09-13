#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extrair_pdfs.py
Extrai os horários dos PDFs em ./pdfs_horarios/ usando pdfplumber (geometria x/y).

Uso:
    py extrair_pdfs.py pdfs_horarios/B003.pdf -o teste_b003.json   # 1 ficheiro -> JSON
    py extrair_pdfs.py --all -o horarios_extraidos.json            # todos

Layouts suportados:
  A) "Espelhado" — coluna central "Localidades"; tempos à ESQUERDA = Ida
     (top->bottom), tempos à DIREITA = Volta (bottom->top); marcadores P/C
     junto ao nome da paragem.
  B) "Blocos" — secções "PARTIDAS DE X" / "PARTIDAS DE Y", cada uma com a
     sua tabela e a sua divisão de períodos.
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata

import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(HERE, "pdfs_horarios")

TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
DASH_RE = re.compile(r"^-+$")           # '-' ou '--' (sem serviço)
MARKERS = {"P", "C"}

WEEKDAY_HINTS = (
    "feira", "segund", "terç", "terc", "quart", "quint", "sext",
    "sábad", "sabad", "doming", "2ª", "3ª", "4ª", "5ª", "6ª",
)


def log(*args):
    print(*args, file=sys.stderr)


def reconfigure_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def is_time(text):
    return bool(TIME_RE.match(text)) or bool(DASH_RE.match(text))


def is_data_line(ln):
    """Linha de dados: tem hora HH:MM, ou só '-' mas com marcador P/C (ex.: 'Salto')."""
    words = _juntar_tempos_partidos(ln["words"])
    texts = [w["text"] for w in words]
    if any(TIME_RE.match(t) for t in texts):
        return True
    return any(t in MARKERS for t in texts) and any(DASH_RE.match(t) for t in texts)


def has_weekday_hint(text):
    t = text.lower()
    return any(h in t for h in WEEKDAY_HINTS)


def _sem_acentos(s):
    """Remove acentos (para comparações insensíveis a 'PERIODO'/'PERÍODO')."""
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )


DIA_ORDEM = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"]
DIA_ROTULO = {
    "segunda": "segunda_feira", "terca": "terca_feira", "quarta": "quarta_feira",
    "quinta": "quinta_feira", "sexta": "sexta_feira", "sabado": "sabado", "domingo": "domingo",
}
ORDINAL_DIA = {"2a": "segunda", "3a": "terca", "4a": "quarta", "5a": "quinta", "6a": "sexta"}


def normalizar_dias(texto):
    """Normaliza o cabeçalho de dias para um valor canónico (ex.: 'dias_uteis')."""
    if not texto:
        return ""
    t = _sem_acentos(texto.lower()).replace("ª", "a").replace("º", "o")
    t = re.sub(r"[.,;:()\[\]'\"-]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()

    if re.search(r"\b2a\s*a\s*6a\b", t) or re.search(r"segunda\s*a\s*sexta", t):
        return "dias_uteis"
    if "todos os dias" in t or "diariamente" in t:
        return "todos_os_dias"

    # Letter-spacing: deteta "Segundas Terças Quartas Quintas Sextas" mesmo com
    # as letras separadas por espaços (ex.: "S e g u n d a s  T e r ç a s ...").
    sem_espacos = t.replace(" ", "")
    if all(k in sem_espacos for k in ("segunda", "terca", "quarta", "quinta", "sexta")):
        return "dias_uteis"

    dias = set()
    for i, x in enumerate(DIA_ORDEM):
        for j, y in enumerate(DIA_ORDEM):
            if j <= i:
                continue
            if re.search(rf"\b{x}s?\s*a\s*{y}s?\b", t):
                dias.update(DIA_ORDEM[i:j + 1])
    for d in DIA_ORDEM:
        if re.search(rf"\b{d}s?\b", t):
            dias.add(d)
    for m in re.finditer(r"\b([2-6])a", t):
        dias.add(ORDINAL_DIA[m.group(1) + "a"])

    if not dias:
        return ""
    if dias == set(DIA_ORDEM[:5]):
        return "dias_uteis"
    if dias == set(DIA_ORDEM):
        return "todos_os_dias"
    return " + ".join(DIA_ROTULO[d] for d in DIA_ORDEM if d in dias)


def _periodo_letivo(inicio, fim):
    """Decide se o intervalo de meses é letivo (setembro->julho) ou não."""
    if inicio.startswith("setem") and fim.startswith("jul"):
        return True
    if inicio.startswith(("jul", "ago")) and fim.startswith(("setem", "ago")):
        return False
    return True


def _classificar_periodo(texto):
    """Devolve 'escolar' | 'nao_escolar' | 'anual' | None para uma linha de cabeçalho."""
    t = _sem_acentos(texto.lower()).replace("ª", "a").replace("º", "o")
    t = re.sub(r"\s+", " ", t).strip()

    if t.startswith("periodo"):
        return "nao_escolar" if "nao" in t else "escolar"

    if "todo o ano" in t:
        return "anual"

    m = re.search(r"\bde\s+\d{1,2}\s*/\s*([a-z]+)\s+a\s+\d{1,2}\s*/\s*([a-z]+)", t)
    if m:
        return "escolar" if _periodo_letivo(m.group(1), m.group(2)) else "nao_escolar"

    return None


FRAG_RE = re.compile(r"^(?::\d{1,2}|\d{1,2}|:)$")


def _juntar_tempos_partidos(words):
    """Junta fragmentos de hora partidos pelo OCR ('1','1',':56' -> '11:56')."""
    out = []
    frags = []

    def flush():
        if frags:
            digits = "".join(re.sub(r"\D", "", w["text"]) for w in frags)
            if 3 <= len(digits) <= 4:
                merged = dict(frags[0])
                merged["x1"] = frags[-1]["x1"]
                merged["bottom"] = max(w["bottom"] for w in frags)
                merged["text"] = f"{digits[:-2]}:{digits[-2:]}"
                out.append(merged)
            else:
                out.extend(frags)
            frags.clear()

    for w in words:
        if FRAG_RE.match(w["text"]):
            frags.append(w)
        else:
            flush()
            out.append(w)
    flush()
    return out


def _resolver_sem_periodo(periodos, sem_periodo, dias, lines):
    """Sem cabeçalho de período: usa a nota 'a): períodos escolares' (escolar) ou assume anual."""
    if not sem_periodo:
        return
    if any(periodos[k] for k in periodos):
        return
    texto_todo = _sem_acentos(" ".join(ln["text"] for ln in lines).lower())
    periodo = "escolar" if ("escolar" in texto_todo and "periodo" in texto_todo) else "anual"
    for r in sem_periodo:
        r["periodo"] = periodo
    periodos[periodo].extend(sem_periodo)
    dias[periodo] = normalizar_dias(
        " ".join(ln["text"] for ln in lines if has_weekday_hint(ln["text"]))
    )


# ---------------------------------------------------------------- palavras / linhas

def extract_words(page):
    return page.extract_words(
        keep_blank_chars=False,
        use_text_flow=False,
        extra_attrs=["size"],
    )


def cluster_lines(words, tol=5.0):
    """Agrupa palavras numa página em linhas (por coordenada `top`).

    A tolerância de 5pt cobre PDFs em que os tempos e o nome da paragem
    estão em baselines ligeiramente desfasadas (ex.: S763, ~3pt)."""
    lines = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        placed = False
        for ln in lines:
            if abs(ln["top"] - w["top"]) <= tol:
                ln["words"].append(w)
                ln["top"] = min(ln["top"], w["top"])
                ln["bottom"] = max(ln["bottom"], w["bottom"])
                placed = True
                break
        if not placed:
            lines.append({"top": w["top"], "bottom": w["bottom"], "words": [w]})
    for ln in lines:
        ln["words"].sort(key=lambda w: w["x0"])
        ln["text"] = " ".join(w["text"] for w in ln["words"])
    lines.sort(key=lambda ln: ln["top"])
    return lines


def page_lines(page, page_index):
    lines = cluster_lines(extract_words(page))
    for ln in lines:
        ln["page"] = page_index
    return lines


# ---------------------------------------------------------------- cabeçalhos globais

def find_linha(lines):
    for ln in lines:
        t = ln["text"].strip()
        if re.match(r"^Linha\b", t, re.IGNORECASE):
            return t
    return None


def find_vigencia(lines):
    for ln in lines:
        m = re.search(r"A PARTIR DE\s+(.+)$", ln["text"].strip(), re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def has_blocks(lines):
    return any(
        re.match(r"^PARTIDAS DE\b", ln["text"].strip(), re.IGNORECASE)
        for ln in lines
    )


# ---------------------------------------------------------------- alinhamento de colunas

def _colunas_x(xs, tol=10.0):
    """Agrupa centros X em colunas (média por coluna), da esquerda para a direita.

    Células em branco/seta não geram palavra, por isso cada paragem tem uma lista
    de tempos com tamanho diferente. Esta função reconstrói as posições das colunas
    a partir de TODOS os tempos do período, para depois alinhar as paragens."""
    grupos = []
    for x in sorted(xs):
        if grupos and x - grupos[-1][-1] <= tol:
            grupos[-1].append(x)
        else:
            grupos.append([x])
    return [sum(g) / len(g) for g in grupos]


def _alinhar_tempos(times, colunas, tol=15.0):
    """Alinha os tempos (centro X, texto) às colunas; '-' onde a célula está vazia."""
    if not colunas:
        return [texto for _, texto in times]
    res = ["-"] * len(colunas)
    for x, texto in times:
        idx = min(range(len(colunas)), key=lambda i: abs(colunas[i] - x))
        if abs(colunas[idx] - x) <= tol:
            res[idx] = texto
    return res


# ---------------------------------------------------------------- layout espelhado

def split_mirrored_row(ln):
    """Linha do layout espelhado: nome central + tempos à esquerda/direita + P/C.

    Os tempos são devolvidos com o centro X (x0+x1)/2 para permitir o alinhamento
    das colunas entre paragens (células em branco/seta não geram palavra)."""
    words = _juntar_tempos_partidos(ln["words"])
    non_time = [w for w in words if not is_time(w["text"])]

    name_words = [w for w in non_time if w["text"] not in MARKERS]
    if not name_words:
        return None

    name_min_x = min(w["x0"] for w in name_words)
    name_max_x = max(w["x1"] for w in name_words)

    left = [w for w in words if w["x1"] <= name_min_x + 0.5]
    right = [w for w in words if w["x0"] >= name_max_x - 0.5]

    ida_marker = next((w["text"] for w in left if w["text"] in MARKERS), None)
    volta_marker = next((w["text"] for w in right if w["text"] in MARKERS), None)

    def _tempos(ws):
        return [((w["x0"] + w["x1"]) / 2.0, w["text"]) for w in ws if is_time(w["text"])]

    return {
        "top": ln["top"],
        "nome": " ".join(w["text"] for w in name_words),
        "ida_marker": ida_marker,
        "volta_marker": volta_marker,
        "tempos_ida": _tempos(left),
        "tempos_volta": _tempos(right),
    }


def parse_mirrored_direcoes(lines):
    periodos = {"escolar": [], "nao_escolar": [], "anual": []}
    sem_periodo = []
    dias = {"escolar": "", "nao_escolar": "", "anual": ""}

    cur_periodo = None
    seen_data = False
    dias_buf = []

    for ln in lines:
        p = _classificar_periodo(ln["text"])
        if p is not None:
            cur_periodo = p
            seen_data = False
            dias_buf = []
            continue

        if is_data_line(ln):
            row = split_mirrored_row(ln)
            if row:
                row["page"] = ln["page"]
                if cur_periodo is None:
                    sem_periodo.append(row)
                else:
                    row["periodo"] = cur_periodo
                    periodos[cur_periodo].append(row)
                    if not seen_data:
                        seen_data = True
                        dias[cur_periodo] = normalizar_dias(" ".join(dias_buf))
            continue

        if cur_periodo is not None and not seen_data and has_weekday_hint(ln["text"]):
            dias_buf.append(ln["text"].strip())

    _resolver_sem_periodo(periodos, sem_periodo, dias, lines)

    ida_periodos = []
    volta_periodos = []
    ida_nome = volta_nome = None

    for periodo in ("escolar", "nao_escolar", "anual"):
        rows = periodos.get(periodo, [])
        if not rows:
            continue
        rows_sorted = sorted(rows, key=lambda r: (r["page"], r["top"]))

        # Reconstrói as colunas (centros X) a partir de todos os tempos do período.
        ida_cols = _colunas_x([x for r in rows_sorted for x, _ in r["tempos_ida"]])
        volta_cols = _colunas_x([x for r in rows_sorted for x, _ in r["tempos_volta"]])

        ida_paragens = [
            {"nome": r["nome"], "marcador": r["ida_marker"],
             "horarios": _alinhar_tempos(r["tempos_ida"], ida_cols)}
            for r in rows_sorted
        ]
        volta_paragens = [
            {"nome": r["nome"], "marcador": r["volta_marker"],
             "horarios": _alinhar_tempos(r["tempos_volta"], volta_cols)}
            for r in reversed(rows_sorted)
        ]

        ida_periodos.append({
            "periodo": periodo,
            "dias": dias.get(periodo, ""),
            "paragens": ida_paragens,
        })
        volta_periodos.append({
            "periodo": periodo,
            "dias": dias.get(periodo, ""),
            "paragens": volta_paragens,
        })

        if ida_nome is None and ida_paragens:
            ida_nome = f"{ida_paragens[0]['nome']} → {ida_paragens[-1]['nome']}"
        if volta_nome is None and volta_paragens:
            volta_nome = f"{volta_paragens[0]['nome']} → {volta_paragens[-1]['nome']}"

    return [
        {"sentido": "ida", "nome": ida_nome, "periodos": ida_periodos},
        {"sentido": "volta", "nome": volta_nome, "periodos": volta_periodos},
    ]


# ---------------------------------------------------------------- layout blocos

def split_block_row(ln):
    """Linha do layout de blocos: nome à esquerda, marcador P/C, tempos à direita."""
    words = _juntar_tempos_partidos(ln["words"])
    name_words = []
    marker = None
    times = []
    for w in words:
        txt = w["text"]
        if is_time(txt):
            times.append(((w["x0"] + w["x1"]) / 2.0, txt))
        elif txt in MARKERS:
            marker = marker or txt
        else:
            name_words.append(txt)
    if not name_words:
        return None
    return {
        "top": ln["top"],
        "nome": " ".join(name_words),
        "marker": marker,
        "times": times,
    }


def parse_blocks_direcoes(lines):
    direcoes = []
    cur = None
    seen_data = False
    dias_buf = []
    sentidos = {}

    for ln in lines:
        t = ln["text"].strip()
        tup = t.upper()
        m = re.match(r"^PARTIDAS DE\s+(.+)$", tup)
        if m:
            m2 = re.match(r"^PARTIDAS DE\s+(.+)$", t, re.IGNORECASE)
            cur = {"origem": m2.group(1).strip(), "periodo": None, "dias": "", "paragens": []}
            direcoes.append(cur)
            seen_data = False
            dias_buf = []
            continue

        p = _classificar_periodo(ln["text"])
        if p is not None:
            if cur is not None:
                cur["periodo"] = p
            seen_data = False
            dias_buf = []
            continue

        if cur is None or cur["periodo"] is None:
            continue

        if is_data_line(ln):
            row = split_block_row(ln)
            if row:
                row["page"] = ln["page"]
                cur["paragens"].append(row)
                if not seen_data:
                    seen_data = True
                    cur["dias"] = normalizar_dias(" ".join(dias_buf))
            continue

        if not seen_data and has_weekday_hint(ln["text"]):
            dias_buf.append(ln["text"].strip())

    resultado = []
    for blk in direcoes:
        paragens = sorted(blk["paragens"], key=lambda r: (r["page"], r["top"]))
        if not paragens:
            continue
        cols = _colunas_x([x for r in paragens for x, _ in r["times"]])
        paragens_out = [
            {"nome": r["nome"], "marcador": r["marker"],
             "horarios": _alinhar_tempos(r["times"], cols)}
            for r in paragens
        ]
        origem = paragens_out[0]["nome"]
        destino = paragens_out[-1]["nome"]
        chave = blk["origem"].upper()
        if chave not in sentidos:
            if not sentidos:
                label = "ida"
            elif len(sentidos) == 1:
                label = "volta"
            else:
                label = f"direcao_{len(sentidos) + 1}"
            sentidos[chave] = label
        resultado.append({
            "sentido": sentidos[chave],
            "nome": f"{origem} → {destino}",
            "periodos": [
                {"periodo": blk["periodo"], "dias": blk["dias"], "paragens": paragens_out}
            ],
        })

    return resultado


# ---------------------------------------------------------------- orquestração

def parse_pdf(path):
    fonte = os.path.basename(path)
    with pdfplumber.open(path) as pdf:
        lines = []
        for i, page in enumerate(pdf.pages):
            lines.extend(page_lines(page, i))
    lines.sort(key=lambda ln: (ln["page"], ln["top"]))

    linha = find_linha(lines)
    vigencia = find_vigencia(lines)

    if has_blocks(lines):
        layout = "blocos"
        direcoes = parse_blocks_direcoes(lines)
    else:
        layout = "espelhado"
        direcoes = parse_mirrored_direcoes(lines)

    return {
        "fonte": fonte,
        "layout": layout,
        "linha": linha,
        "vigencia": vigencia,
        "direcoes": direcoes,
    }


def _tem_dados(r):
    """True se o resultado tem pelo menos uma paragem extraída."""
    for d in (r or {}).get("direcoes", []):
        for p in d.get("periodos", []):
            if p.get("paragens"):
                return True
    return False


def write_json(data, path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def main(argv):
    reconfigure_stdout()

    out = None
    if "-o" in argv or "--out" in argv:
        flag = "-o" if "-o" in argv else "--out"
        idx = argv.index(flag)
        out = argv[idx + 1]
        argv = [a for i, a in enumerate(argv) if i != idx and i != idx + 1]

    if not argv:
        print("Uso: py extrair_pdfs.py <ficheiro.pdf> [-o saida.json] | --all [-o saida.json]", file=sys.stderr)
        return 2

    if argv[0] == "--all":
        pdfs = sorted(f for f in os.listdir(PDF_DIR) if f.lower().endswith(".pdf"))
        resultados = []
        erros = []
        vazios = []
        for f in pdfs:
            path = os.path.join(PDF_DIR, f)
            try:
                r = parse_pdf(path)
            except Exception as e:
                erros.append((f, str(e)))
                log(f"[ERRO] {f}: {e}")
                continue
            if _tem_dados(r):
                resultados.append(r)
            else:
                vazios.append(f)

        out = out or os.path.join(HERE, "horarios_extraidos.json")
        write_json(resultados, out)
        print("=" * 60)
        print(f"Processamento concluído -> {out}")
        print(f"  Total de PDFs:          {len(pdfs)}")
        print(f"  Com dados (sucesso):    {len(resultados)}")
        print(f"  Sem dados (verificar):  {len(vazios)}")
        print(f"  Erros (falharam):       {len(erros)}")
        if vazios:
            print("\nSem dados extraídos (verificação pontual):")
            for f in vazios:
                print(f"  - {f}")
        if erros:
            print("\nErros:")
            for f, e in erros:
                print(f"  - {f}: {e}")
        print("=" * 60)
        return 0

    path = argv[0]
    if not os.path.exists(path):
        alt = os.path.join(PDF_DIR, path)
        if os.path.exists(alt):
            path = alt
        else:
            print(f"Ficheiro não encontrado: {path}", file=sys.stderr)
            return 1

    r = parse_pdf(path)
    if not out:
        out = os.path.join(HERE, f"teste_{os.path.splitext(os.path.basename(path))[0]}.json")
    write_json(r, out)
    print(f"Gerado {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))



