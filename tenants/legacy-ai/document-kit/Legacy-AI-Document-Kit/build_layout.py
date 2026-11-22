"""Editable Word layouts for the Legacy AI stationery kit.

The calling program supplies validated, formatted content. All prices are display
strings. No financial calculations, field substitutions, or network calls take
place in this module.
"""
from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

FOREST = "244337"
INK = "1D2822"
MUTED = "4C5C51"
RULE = "ABB7AC"
PALE = "E9EDE6"
GRID = "D9D9D9"
WHITE = "FFFFFF"
SERIF = "Georgia"
SANS = "Arial"
CONTENT_WIDTH = 6.94
LEFT_MARGIN = (8.5 - CONTENT_WIDTH) / 2
ASSETS = Path(__file__).resolve().parent / "assets"


def xml(tag, **attributes):
    element = OxmlElement(f"w:{tag}")
    for name, value in attributes.items():
        element.set(qn(f"w:{name}"), str(value))
    return element


def color(value):
    return RGBColor.from_string(value)


def style_document(document):
    specs = [
        # Name, family, size in points, weight, color, line spacing, before, after.
        ("Normal", SANS, 11, False, INK, 1.24, 0, 6),
        ("Title", SERIF, 37, False, "000000", 1.03, 0, 3),
        ("Heading 1", SERIF, 17, False, "000000", 1.12, 12, 4),
        ("Heading 2", SERIF, 15, False, "000000", 1.12, 9, 4),
        ("Project subject", SERIF, 18, False, FOREST, 1.15, 0, 12),
        ("Document metadata", SANS, 10, False, INK, 1.17, 0, 2),
        ("Small label", SANS, 8, True, MUTED, 1.10, 0, 4),
        ("Ledger text", SANS, 10.5, False, INK, 1.11, 0, 0),
        ("Item detail", SANS, 9.5, False, MUTED, 1.18, 3, 0),
        ("Letter text", SERIF, 12, False, INK, 1.34, 0, 9),
        ("Footer detail", SANS, 8.5, False, MUTED, 1.14, 0, 0),
    ]
    for name, family, size, bold, ink, spacing, before, after in specs:
        if name not in document.styles:
            document.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        style = document.styles[name]
        if name != "Normal":
            style.base_style = document.styles["Normal"]
        style.font.name = family
        style.font.size = Pt(size)
        style.font.color.rgb = color(ink)
        style.font.bold = bold
        style.font.italic = False
        for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            style.element.get_or_add_rPr().rFonts.attrib.pop(qn(f"w:{attr}"), None)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.line_spacing = spacing
        style.paragraph_format.keep_together = False
        style.paragraph_format.keep_with_next = name in {"Title", "Heading 1", "Heading 2", "Project subject", "Small label"}
        style.paragraph_format.widow_control = True
        if name in {"Title", "Heading 1", "Heading 2"}:
            ppr = style.element.get_or_add_pPr()
            for child in list(ppr):
                if child.tag == qn("w:pBdr"):
                    ppr.remove(child)


def set_inset(table, top=0, bottom=0, left=0, right=0):
    props = table._tbl.tblPr
    previous = props.find(qn("w:tblCellMar"))
    if previous is not None:
        props.remove(previous)
    margins = xml("tblCellMar")
    for side, value in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        margins.append(xml(side, w=value, type="dxa"))
    props.append(margins)


def set_cell_edge(cell, side, ink, size=4):
    props = cell._tc.get_or_add_tcPr()
    borders = props.find(qn("w:tcBorders"))
    if borders is None:
        borders = xml("tcBorders")
        props.append(borders)
    borders.append(xml(side, val="single", sz=size, color=ink))


def sized_table(table, widths, border=None):
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    props = table._tbl.tblPr
    props.find(qn("w:tblW")).set(qn("w:w"), str(round(sum(widths) * 1440)))
    props.find(qn("w:tblW")).set(qn("w:type"), "dxa")
    # Word otherwise applies an inherited left indent to align text inside cells.
    props.append(xml("tblInd", w=0, type="dxa"))
    edges = xml("tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        edges.append(xml(side, val="single", color=border, sz=3) if border else xml(side, val="nil"))
    props.append(edges)
    for column, width in zip(table.columns, widths):
        column.width = Inches(width)
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell.width = Inches(width)
    set_inset(table)
    return table


def fit_row(row, widths, allow_split=False):
    if not allow_split:
        row._tr.get_or_add_trPr().append(xml("cantSplit"))
    for cell, width in zip(row.cells, widths):
        cell.width = Inches(width)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def small_label(paragraph, value, align=WD_ALIGN_PARAGRAPH.LEFT):
    paragraph.style = "Small label"
    paragraph.alignment = align
    run = paragraph.add_run(value.upper())
    run._element.get_or_add_rPr().append(xml("spacing", val=19))
    return run


def paragraph(container, text, style="Normal", first=False):
    p = container.paragraphs[0] if first else container.add_paragraph()
    p.style = style
    p.add_run(text)
    return p


def rule_above(paragraph, ink=RULE, space=6):
    borders = xml("pBdr")
    borders.append(xml("top", val="single", sz=6, color=ink, space=space))
    paragraph._p.get_or_add_pPr().append(borders)


def add_spacer(document, points):
    p = document.add_paragraph()
    fmt = p.paragraph_format
    fmt.line_spacing = Pt(points)
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(0)
    p.add_run().font.size = Pt(1)


def masthead(document, data, logo):
    section = document.sections[0]
    section.page_height = Inches(11)
    section.page_width = Inches(8.5)
    section.left_margin = section.right_margin = Inches(LEFT_MARGIN)
    section.top_margin = Inches(1.52)
    section.bottom_margin = Inches(0.96)
    section.header_distance = Inches(0.50)
    section.footer_distance = Inches(0.40)

    header = section.header
    # A letterhead is a repeated logo and, where applicable, a filing reference.
    widths = (3.80, CONTENT_WIDTH - 3.80)
    table = sized_table(header.add_table(rows=1, cols=2, width=Inches(CONTENT_WIDTH)), widths)
    header._element.remove(header.paragraphs[0]._p)
    header_row = table.rows[0]
    fit_row(header_row, widths)
    left, right = header_row.cells
    p = left.paragraphs[0]
    p.paragraph_format.line_spacing = 1
    p.paragraph_format.space_after = Pt(0)
    # Set the inline drawing's wrap distances explicitly. Writer otherwise
    # reserves nine points to the left although Word draws at the text origin.
    drawing = p.add_run().add_picture(str(logo), width=Inches(1.92))
    for attr in ("distT", "distB", "distL", "distR"):
        drawing._inline.set(attr, "0")
    drawing._inline.docPr.set("descr", "Legacy AI")
    if data["reference"]:
        labels = {"quote": "Quote number", "invoice": "Invoice number", "letter": "Reference", "brief": "Reference"}
        p = right.paragraphs[0]
        small_label(p, labels[data["kind"]], WD_ALIGN_PARAGRAPH.RIGHT)
        p.paragraph_format.space_after = Pt(2)
        p = paragraph(right, data["reference"], "Document metadata")
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p = header.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = Pt(1)
    rule_above(p, space=2)

    footer = section.footer.paragraphs[0]
    footer.style = "Footer detail"
    footer.paragraph_format.tab_stops.add_tab_stop(Inches(CONTENT_WIDTH), WD_TAB_ALIGNMENT.RIGHT)
    rule_above(footer, space=7)
    website = footer.add_run("legacyai.space")
    website.bold = True
    website.font.color.rgb = color(FOREST)
    footer.add_run("\tPage ")
    field = xml("fldSimple", instr="PAGE")
    field_run = xml("r")
    field_text = xml("t")
    field_text.text = "1"
    field_run.append(field_text)
    field.append(field_run)
    footer._p.append(field)
    second = section.footer.add_paragraph(style="Footer detail")
    second.paragraph_format.space_before = Pt(3)
    second.paragraph_format.tab_stops.add_tab_stop(Inches(CONTENT_WIDTH), WD_TAB_ALIGNMENT.RIGHT)
    second.add_run("douglas@legacyai.space    ·    812-412-3454")
    second.add_run("\tBrown County, Indiana")


def recipient_lines(client, company_first):
    primary = [client["company"], client["name"]] if company_first else [client["name"], client["company"]]
    return [line for line in [*primary, *client["address"]] if line]


def cell_text(cell, text, style="Document metadata", bold=False, first=False, align=None):
    p = paragraph(cell, text, style, first=first)
    if bold:
        p.runs[0].bold = True
    if align is not None:
        p.alignment = align
    return p


def document_meta(document, data, kind):
    details = []
    if data["date"]:
        details.append(("Issued", data["date"]))
    if data["until"]:
        details.append(("Valid through" if kind == "quote" else "Payment due", data["until"]))
    recipient = recipient_lines(data["client"], company_first=True)
    if not recipient and not details:
        return
    if recipient:
        groups = [("Bill to" if kind == "invoice" else "Prepared for", recipient), *[(k, [v]) for k, v in details]]
        widths = {1: (CONTENT_WIDTH,), 2: (3.94, 3.0), 3: (3.42, 1.76, 1.76)}[len(groups)]
    else:
        groups = [(k, [v]) for k, v in details]
        widths = (CONTENT_WIDTH,) if len(groups) == 1 else (3.47, 3.47)
    table = sized_table(document.add_table(rows=1, cols=len(groups)), widths)
    row = table.rows[0]
    fit_row(row, widths, allow_split=True)
    for cell, (label, lines) in zip(row.cells, groups):
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
        small_label(cell.paragraphs[0], label)
        for index, line in enumerate(lines):
            cell_text(cell, line, bold=index == 0 and label in {"Bill to", "Prepared for"})
    add_spacer(document, 9)


def prose(document, text, style="Normal"):
    # Commercial notes often contain embedded newlines. Preserve them without
    # manufacturing extra blank paragraphs in user-facing output.
    if text:
        paragraph(document, text, style)


def topic(document, name):
    return paragraph(document, name, "Heading 1")


def sections(document, blocks, body_style="Normal"):
    for block in blocks:
        if block["heading"]:
            topic(document, block["heading"])
        for body in block["body"]:
            prose(document, body, body_style)


def ledger(document, data):
    widths = (3.35, 1.02, 1.17, 1.40)
    table = sized_table(document.add_table(rows=1, cols=4), widths, border=GRID)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_inset(table, top=85, bottom=85, left=105, right=105)
    headline = table.rows[0]
    fit_row(headline, widths)
    headline._tr.get_or_add_trPr().append(xml("tblHeader", val=1))
    for index, (cell, label) in enumerate(zip(headline.cells, ("Work", "Qty", "Unit price", "Amount"))):
        p = cell.paragraphs[0]
        small_label(p, label, WD_ALIGN_PARAGRAPH.RIGHT if index else WD_ALIGN_PARAGRAPH.LEFT)
        p.runs[0].font.color.rgb = color(FOREST)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.keep_with_next = False
        cell._tc.get_or_add_tcPr().append(xml("shd", fill=PALE))
    for item in data["items"]:
        row = table.add_row()
        fit_row(row, widths)
        for index, key in enumerate(("description", "qty", "unit_price", "amount")):
            cell = row.cells[index]
            p = cell_text(cell, item[key], "Ledger text", bold=index in {0, 3}, first=True,
                          align=WD_ALIGN_PARAGRAPH.RIGHT if index else WD_ALIGN_PARAGRAPH.LEFT)
            if index == 0 and item["detail"]:
                cell_text(cell, item["detail"], "Item detail")
    add_spacer(document, 4)


def totals(document, rows, currency):
    widths = (2.52, 1.44)
    table = sized_table(document.add_table(rows=0, cols=2), widths)
    table.alignment = WD_TABLE_ALIGNMENT.RIGHT
    set_inset(table, top=45, bottom=45, left=105, right=105)
    for index, entry in enumerate(rows):
        row = table.add_row()
        fit_row(row, widths)
        last = index == len(rows) - 1
        for col, key in enumerate(("label", "amount")):
            value = entry[key]
            if last and col == 0 and currency:
                value = f"{value} ({currency})"
            p = cell_text(row.cells[col], value, "Ledger text", first=True,
                          align=WD_ALIGN_PARAGRAPH.RIGHT if col else WD_ALIGN_PARAGRAPH.LEFT)
            p.paragraph_format.keep_with_next = not last
            if last:
                set_cell_edge(row.cells[col], "top", FOREST, size=8)
                run = p.runs[0]
                run.bold = True
                run.font.color.rgb = color(FOREST)
                run.font.size = Pt(15 if col else 11.5)
                p.paragraph_format.space_before = Pt(4)
                p.paragraph_format.space_after = Pt(1)


def titled_block(document, title, paragraphs):
    if not paragraphs:
        return
    topic(document, title)
    for text in paragraphs:
        prose(document, text)


def transaction(document, data):
    kind = data["kind"]
    paragraph(document, data["title"], "Title")
    if data["subject"]:
        paragraph(document, data["subject"], "Project subject")
    document_meta(document, data, kind)
    prose(document, data["intro"])
    sections(document, data["sections"])
    if data["items"]:
        ledger(document, data)
    if data["totals"]:
        totals(document, data["totals"], data["currency"])
    titled_block(document, "Terms", data["terms"])
    if data["payment"]:
        titled_block(document, "How to pay", [data["payment"]])
    if data["next_step"]:
        titled_block(document, "Next step", [data["next_step"]])
    signature(document, data["signoff"], "Normal")


def signature(document, signoff, body_style):
    if signoff["closing"]:
        p = paragraph(document, signoff["closing"], body_style)
        p.paragraph_format.space_before = Pt(8)
        p.paragraph_format.space_after = Pt(7)
        p.paragraph_format.keep_with_next = bool(signoff["name"] or signoff["role"])
    if signoff["name"]:
        p = paragraph(document, signoff["name"], "Normal")
        p.runs[0].bold = True
        p.paragraph_format.space_after = Pt(1)
        p.paragraph_format.keep_with_next = bool(signoff["role"])
    if signoff["role"]:
        paragraph(document, signoff["role"], "Document metadata")


def letter(document, data):
    if data["date"]:
        p = paragraph(document, data["date"], "Document metadata")
        p.paragraph_format.space_after = Pt(14)
    lines = recipient_lines(data["client"], company_first=False)
    for index, line in enumerate(lines):
        p = paragraph(document, line, "Document metadata")
        p.runs[0].bold = index == 0
        p.paragraph_format.keep_with_next = index < len(lines) - 1
        p.paragraph_format.space_after = Pt(12 if index == len(lines) - 1 else 2)
    title = data["subject"] or (data["title"] if data["title"].lower() != "letter" else "")
    if title:
        p = paragraph(document, title, "Title")
        p.runs[0].font.size = Pt(26)
        p.paragraph_format.space_after = Pt(13)
    if data["salutation"]:
        p = paragraph(document, data["salutation"], "Letter text")
        p.paragraph_format.keep_with_next = True
    prose(document, data["intro"], "Letter text")
    sections(document, data["sections"], "Letter text")
    prose(document, data["next_step"], "Letter text")
    signature(document, data["signoff"], "Letter text")


def brief(document, data):
    paragraph(document, data["title"], "Title")
    if data["subject"]:
        paragraph(document, data["subject"], "Project subject")
    document_meta(document, data, "brief")
    prose(document, data["intro"])
    sections(document, data["sections"])
    if data["next_step"]:
        titled_block(document, "Next step", [data["next_step"]])
    signature(document, data["signoff"], "Normal")


def render_document(data, output, logo_path=None):
    """Write a native, editable .docx using normalized input from generate.py."""
    render_kind = {"quote": transaction, "invoice": transaction, "letter": letter, "brief": brief}
    kind = data["kind"]
    if kind not in render_kind:
        raise ValueError(f"Unknown stationery type: {kind}")
    logo = Path(logo_path) if logo_path else ASSETS / "legacy-ai-lockup.png"
    document = Document()
    document.core_properties.title = data["subject"] or data["title"]
    document.core_properties.author = "Legacy AI"
    document.core_properties.subject = data["title"]
    document.core_properties.keywords = ""
    document.core_properties.comments = ""
    style_document(document)
    masthead(document, data, logo)
    if data["sample"]:
        p = document.add_paragraph()
        small_label(p, "Illustrative sample")
        p.paragraph_format.space_after = Pt(7)
    render_kind[kind](document, data)
    document.save(str(output))
