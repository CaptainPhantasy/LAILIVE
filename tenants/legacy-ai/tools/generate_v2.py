"""Legacy AI stationery v2 — upgraded layout honoring brand/TEMPLATE-QUALITY-CRITERIA.md.

Reuses the kit's validated generator and layout primitives unchanged (JSON
contract, masthead, styles, footers, money handling) and overrides exactly two
visual systems:

  * ledger(): the item table loses its full grid. Structure is carried by a
    forest rule under the column headings and hairline rules under each row
    (the "ledger rule" signature in tenants/legacy-ai/DESIGN.md).
  * totals(): gains a hairline opening rule so the totals block reads as a
    ruled ledger summary, closing with the existing heavy forest rule.

Everything else — letters, briefs, blank forms, metadata, footers — is the
kit's own code, imported from the unpacked kit directory.
"""
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent / "document-kit" / "Legacy-AI-Document-Kit"
if str(KIT) not in sys.path:
    sys.path.insert(0, str(KIT))

import build_layout as B  # noqa: E402
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT  # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH  # noqa: E402
from docx.shared import Pt  # noqa: E402


def ledger_v2(document, data):
    widths = (3.35, 1.02, 1.17, 1.40)
    table = B.sized_table(document.add_table(rows=1, cols=4), widths, border=None)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    B.set_inset(table, top=85, bottom=85, left=105, right=105)
    table._tbl.tblPr.find(B.qn("w:tblInd")).set(B.qn("w:w"), "105")
    headline = table.rows[0]
    B.fit_row(headline, widths)
    headline._tr.get_or_add_trPr().append(B.xml("tblHeader", val=1))
    for index, (cell, label) in enumerate(zip(headline.cells, ("Work", "Qty", "Unit price", "Amount"))):
        p = cell.paragraphs[0]
        B.small_label(p, label, WD_ALIGN_PARAGRAPH.RIGHT if index else WD_ALIGN_PARAGRAPH.LEFT)
        p.runs[0].font.color.rgb = B.color(B.FOREST)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.keep_with_next = False
        cell._tc.get_or_add_tcPr().append(B.xml("shd", fill=B.PALE))
        B.set_cell_edge(cell, "bottom", B.FOREST, size=8)
    rows = list(data["items"])
    for position, item in enumerate(rows):
        row = table.add_row()
        B.fit_row(row, widths)
        last = position == len(rows) - 1
        for index, key in enumerate(("description", "qty", "unit_price", "amount")):
            cell = row.cells[index]
            p = B.cell_text(cell, item[key], "Ledger text", bold=index in {0, 3}, first=True,
                            align=WD_ALIGN_PARAGRAPH.RIGHT if index else WD_ALIGN_PARAGRAPH.LEFT)
            if index == 0 and item["detail"]:
                B.cell_text(cell, item["detail"], "Item detail")
            B.set_cell_edge(cell, "bottom", B.RULE, size=4)
    B.add_spacer(document, 4)


def totals_v2(document, rows, currency):
    """Full-width ledger summary: labels right-hug the amounts, one shared right
    edge with the item table, hairline opener, heavy forest close."""
    widths = (5.50, 1.44)
    table = B.sized_table(document.add_table(rows=0, cols=2), widths)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    B.set_inset(table, top=45, bottom=45, left=105, right=105)
    table._tbl.tblPr.find(B.qn("w:tblInd")).set(B.qn("w:w"), "105")
    for index, entry in enumerate(rows):
        row = table.add_row()
        B.fit_row(row, widths)
        first = index == 0
        last = index == len(rows) - 1
        for col, key in enumerate(("label", "amount")):
            value = entry[key]
            if last and col == 0 and currency:
                value = f"{value} ({currency})"
            p = B.cell_text(row.cells[col], value, "Ledger text", first=True,
                            align=WD_ALIGN_PARAGRAPH.RIGHT)
            p.paragraph_format.keep_with_next = not last
            if first:
                B.set_cell_edge(row.cells[col], "top", B.RULE, size=4)
            if last:
                B.set_cell_edge(row.cells[col], "top", B.FOREST, size=8)
                run = p.runs[0]
                run.bold = True
                run.font.color.rgb = B.color(B.FOREST)
                run.font.size = Pt(15 if col else 11.5)
                p.paragraph_format.space_before = Pt(4)
                p.paragraph_format.space_after = Pt(1)


def transaction_v2(document, data):
    B.paragraph(document, data["title"], "Title")
    if data["subject"]:
        B.paragraph(document, data["subject"], "Project subject")
    B.document_meta(document, data, data["kind"])
    B.prose(document, data["intro"])
    B.sections(document, data["sections"])
    if data["items"]:
        ledger_v2(document, data)
    if data["totals"]:
        totals_v2(document, data["totals"], data["currency"])
    B.titled_block(document, "Terms", data["terms"])
    if data["payment"]:
        B.titled_block(document, "How to pay", [data["payment"]])
    if data["next_step"]:
        B.titled_block(document, "Next step", [data["next_step"]])
    B.signature(document, data["signoff"], "Normal")


def render_document_v2(data, output, logo_path=None):
    logo = Path(logo_path) if logo_path else B.ASSETS / "legacy-ai-lockup.png"
    document = B.Document()
    document.core_properties.title = data["subject"] or data["title"]
    document.core_properties.author = "Legacy AI"
    document.core_properties.subject = data["title"]
    document.core_properties.keywords = ""
    document.core_properties.comments = ""
    B.style_document(document)
    document.styles["Title"].font.color.rgb = B.color(B.INK)
    B.masthead(document, data, logo)
    if data["sample"]:
        p = document.add_paragraph()
        B.small_label(p, "Illustrative sample")
        p.paragraph_format.space_after = Pt(7)
    kind = data["kind"]
    builders = {"quote": transaction_v2, "invoice": transaction_v2, "letter": B.letter, "brief": B.brief}
    if kind not in builders:
        raise ValueError(f"Unknown stationery type: {kind}")
    builders[kind](document, data)
    document.save(str(output))


def main(argv=None):
    import argparse
    import json
    import os
    import tempfile
    import generate as kitgen

    parser = argparse.ArgumentParser(description="Generate v2 Legacy AI Word documents.")
    parser.add_argument("--blank", choices=kitgen.KINDS, metavar="TYPE")
    parser.add_argument("input", nargs="?", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args(argv)
    if (args.blank is None) == (args.input is None):
        parser.error("Supply either an input JSON file or --blank TYPE.")
    if args.output.suffix.lower() != ".docx":
        parser.error("The output filename must end with .docx.")
    tmp_path = None
    try:
        if args.blank:
            doc = kitgen.blank_document(args.blank)
        else:
            with args.input.open(encoding="utf-8-sig") as source:
                raw = json.load(source, parse_float=kitgen.Decimal, object_pairs_hook=kitgen.strict_object)
            doc = kitgen.normalize_document(raw)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".docx", delete=False) as temp:
            tmp_path = Path(temp.name)
        render_document_v2(doc, tmp_path)
        os.replace(tmp_path, args.output)
    except (kitgen.InputError, json.JSONDecodeError, OSError, UnicodeError) as exc:
        print(f"Cannot generate document: {exc}", file=sys.stderr)
        return 1
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
