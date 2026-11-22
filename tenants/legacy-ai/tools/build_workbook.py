"""Build Legacy-AI-Calculator.xlsx — quote/invoice math workbook.

Excel best practice (per brand/TEMPLATE-QUALITY-CRITERIA.md C11 and the
financial-modeling consensus): inputs live on their own sheet in blue, every
displayed figure is a live formula, nothing is hardcoded. The invoice due date
is the Net-7 policy expressed as a formula (=Issued+7). Print views for the
quote and the invoice are formatted to the stationery tokens and set up for
US Letter printing.

v2 (post adversarial review): totals chains reference value cells (D column,
not labels); quote and invoice carry their own reference and date inputs; both
views display issued/due dates; Inputs sheet got wrap, footer and print setup.
"""
import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.properties import PageSetupProperties
from openpyxl.drawing.image import Image as XLImage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "templates" / "Legacy-AI-Calculator.xlsx"
LOGO = ROOT / "document-kit" / "Legacy-AI-Document-Kit" / "assets" / "legacy-ai-lockup.png"

def add_logo(sheet):
    img = XLImage(str(LOGO)); img.width = 176; img.height = 29
    sheet.add_image(img, "A1")
    sheet.row_dimensions[1].height = 30

FOREST, INK, MUTED, PALE, RULE = "244337", "1D2822", "4C5C51", "E9EDE6", "ABB7AC"
SERIF, SANS = "Georgia", "Arial"
BLUE_INPUT = "1F4E79"  # the convention: blue = input, black = formula
hair = Side(style="thin", color=RULE)
forest_heavy = Side(style="medium", color=FOREST)
ISSUED = datetime.date(2026, 11, 20)

wb = Workbook()

# ---------------- Inputs ----------------
ws = wb.active
ws.title = "Inputs"
ws.sheet_view.showGridLines = False
ws.column_dimensions["A"].width = 58
for col, width in zip("BCDE", (10, 14, 14, 16)):
    ws.column_dimensions[col].width = width

add_logo(ws)
ws["A2"] = "Blue cells are inputs. Every other figure in this workbook is a formula."
ws["A2"].font = Font(name=SANS, size=10, color=MUTED)

meta = [
    (4, "Reference (quote)", "Q-026"),
    (5, "Client", "Juniper Bench Service Co. (sample)"),
    (6, "Issued", ISSUED),
    (7, "Quote valid through", datetime.date(2026, 12, 4)),
    (8, "Reference (invoice)", "INV-026"),
]
for row, label, value in meta:
    ws[f"A{row}"] = label; ws[f"A{row}"].font = Font(name=SANS, size=10, color=INK)
    ws[f"B{row}"] = value
    cell = ws[f"B{row}"]
    cell.font = Font(name=SANS, size=10, color=BLUE_INPUT)
    if isinstance(value, datetime.date):
        cell.number_format = "yyyy-mm-dd"
ws["A9"] = "Invoice due (Net 7 — formula, not an input)"
ws["A9"].font = Font(name=SANS, size=10, color=MUTED)
ws["B9"] = "=B6+7"
ws["B9"].font = Font(name=SANS, size=10, color=INK)
ws["B9"].number_format = "yyyy-mm-dd"

ws["A11"] = "Work"; ws["B11"] = "Qty"; ws["C11"] = "Unit price"
for cell in ("A11", "B11", "C11"):
    ws[cell].font = Font(name=SANS, size=9, bold=True, color=FOREST)
    ws[cell].fill = PatternFill("solid", fgColor=PALE)
    ws[cell].border = Border(bottom=forest_heavy)
SAMPLE_ITEMS = [
    ("After-hours call setup — greeting, intake questions, dispatch summary", 1, 640.00),
    ("Routing and test calls with your dispatcher (hours)", 2, 95.00),
    ("Dispatcher handoff — walkthrough and one-page reference", 1, 120.00),
]
for index, (desc, qty, price) in enumerate(SAMPLE_ITEMS):
    row = 12 + index
    ws[f"A{row}"] = desc
    ws[f"A{row}"].font = Font(name=SANS, size=10, color=BLUE_INPUT)
    ws[f"A{row}"].alignment = Alignment(wrap_text=True, vertical="top")
    ws[f"B{row}"] = qty; ws[f"B{row}"].font = Font(name=SANS, size=10, color=BLUE_INPUT)
    ws[f"C{row}"] = price; ws[f"C{row}"].font = Font(name=SANS, size=10, color=BLUE_INPUT)
    ws[f"C{row}"].number_format = '$#,##0.00'
ws["A16"] = "Tax charged"; ws["A16"].font = Font(name=SANS, size=10, color=INK)
ws["C16"] = 0.00
ws["C16"].font = Font(name=SANS, size=10, color=BLUE_INPUT); ws["C16"].number_format = '$#,##0.00'
ws["A17"] = "Payment received (invoice only)"; ws["A17"].font = Font(name=SANS, size=10, color=INK)
ws["C17"] = 250.00
ws["C17"].font = Font(name=SANS, size=10, color=BLUE_INPUT); ws["C17"].number_format = '$#,##0.00'
ws["A18"] = "Credit applied (invoice only)"; ws["A18"].font = Font(name=SANS, size=10, color=INK)
ws["C18"] = 0.00
ws["C18"].font = Font(name=SANS, size=10, color=BLUE_INPUT); ws["C18"].number_format = '$#,##0.00'
ws.merge_cells("B5:E5")
ws.print_area = "A1:E18"
ws.page_setup.orientation = "portrait"
ws.page_setup.paperSize = 1
ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.oddFooter.left.text = '&"Arial"&8&K4C5C51legacyai.space · douglas@legacyai.space · 812-412-3454 · Brown County, Indiana'
ws.oddFooter.right.text = '&"Arial"&8&K4C5C51Page &P' 

# ---------------- Print views ----------------
def build_view(name, kind):
    view = wb.create_sheet(name)
    view.sheet_view.showGridLines = False
    view.column_dimensions["A"].width = 46
    for col, width in zip("BCD", (10, 14, 15)):
        view.column_dimensions[col].width = width
    add_logo(view)
    view["D1"] = f"{'QUOTE' if kind == 'quote' else 'INVOICE'} NO."
    view["D1"].font = Font(name=SANS, size=9, bold=True, color=MUTED)
    view["D2"] = "=Inputs!B4" if kind == "quote" else "=Inputs!B8"
    view["D2"].font = Font(name=SANS, size=11, color=INK)
    for col in "ABCD":
        view[f"{col}3"].border = Border(bottom=forest_heavy)
    view["A5"] = "Quote" if kind == "quote" else "Invoice"
    view["A5"].font = Font(name=SERIF, size=30, color=INK)
    view["A6"] = "=Inputs!B5"
    view["A6"].font = Font(name=SANS, size=11, color=INK)
    view.merge_cells("A7:B7")
    view["A7"] = '="Issued  "&TEXT(Inputs!B6,"mmmm d, yyyy")'
    view["A7"].font = Font(name=SANS, size=10, color=INK)
    due = "Valid through" if kind == "quote" else "Payment due (Net 7)"
    view.merge_cells("A8:D8")
    view["A8"] = f'="{due}  "&TEXT(Inputs!{"B7" if kind == "quote" else "B9"},"mmmm d, yyyy")'
    view["A8"].font = Font(name=SANS, size=10, color=INK)
    view["A8"].alignment = Alignment(horizontal="right")
    view["A9"] = "Work"; view["B9"] = "Qty"; view["C9"] = "Unit price"; view["D9"] = "Amount"
    for col in "ABCD":
        cell = view[f"{col}9"]
        cell.font = Font(name=SANS, size=10, bold=True, color=FOREST)
        cell.fill = PatternFill("solid", fgColor=PALE)
        cell.border = Border(bottom=forest_heavy)
    for index in range(3):
        row = 10 + index
        src = 12 + index
        view[f"A{row}"] = f"=Inputs!A{src}"
        view[f"B{row}"] = f"=Inputs!B{src}"
        view[f"C{row}"] = f"=Inputs!C{src}"
        view[f"D{row}"] = f"=Inputs!B{src}*Inputs!C{src}"
        for col in "ABCD":
            view[f"{col}{row}"].font = Font(name=SANS, size=10, color=INK)
            view[f"{col}{row}"].border = Border(bottom=hair)
        view[f"C{row}"].number_format = '$#,##0.00'
        view[f"D{row}"].number_format = '$#,##0.00'
        view[f"C{row}"].alignment = Alignment(horizontal="right")
        view[f"D{row}"].alignment = Alignment(horizontal="right")
    if kind == "quote":
        rows = [("Subtotal", "=SUM(D10:D12)"), ("Tax", "=Inputs!C16"), ("Quote total (USD)", "=D18+D19")]
    else:
        rows = [("Subtotal", "=SUM(D10:D12)"), ("Tax", "=Inputs!C16"),
                ("Invoice total", "=D18+D19"), ("Payment received", "=-Inputs!C17"),
                ("Credit applied", "=-Inputs!C18"), ("Amount due (USD)", "=D19+D20+D21")]
    start = 18
    for index, (label, formula) in enumerate(rows):
        row = start + index
        last = index == len(rows) - 1
        view[f"C{row}"] = label
        view[f"D{row}"] = formula
        view[f"C{row}"].font = Font(name=SANS, size=11 if last else 10, bold=last, color=FOREST if last else INK)
        view[f"D{row}"].font = Font(name=SANS, size=13 if last else 10, bold=last, color=FOREST if last else INK)
        view[f"D{row}"].number_format = '$#,##0.00'
        view[f"C{row}"].alignment = Alignment(horizontal="right")
        view[f"D{row}"].alignment = Alignment(horizontal="right")
        if index == 0:
            for col in "CD":
                view[f"{col}{row}"].border = Border(top=hair)
        if last:
            for col in "CD":
                view[f"{col}{row}"].border = Border(top=forest_heavy)
    footer_row = start + len(rows) - 1
    view.print_area = f"A1:D{footer_row}"
    view.page_setup.orientation = "portrait"
    view.page_setup.paperSize = 1  # US Letter
    view.page_margins.left = view.page_margins.right = 0.9
    view.page_margins.top = 1.0
    view.page_margins.bottom = 1.0
    view.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    view.page_setup.fitToWidth = 1
    view.page_setup.fitToHeight = 0
    view.oddFooter.left.text = '&"Arial"&8&K4C5C51legacyai.space · douglas@legacyai.space · 812-412-3454 · Brown County, Indiana'
    view.oddFooter.right.text = '&"Arial"&8&K4C5C51Page &P' 
    return view

build_view("Quote", "quote")
build_view("Invoice", "invoice")
wb.save(str(OUT))
print(OUT)
