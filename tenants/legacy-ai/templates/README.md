# Legacy AI stationery — tenant template set (v2)

Tenant-scoped: these are Legacy AI's (current tenant) document templates. They are
not platform defaults; other tenants must never inherit them. Built 2026-11-20 to
a documented quality standard; design rules and review evidence are kept outside
the public tree. The owner document schema this set serves is documented there too.

## Files

Blank forms (bracketed fields, real Word styles):

| File | What it is |
|---|---|
| `Legacy-AI-Letterhead.dotx` | Blank stationery template — open in Word, new documents inherit masthead + footer |
| `Legacy-AI-Blank-Letter.docx` | Blank letter form |
| `Legacy-AI-Blank-Quote.docx` | Blank quote form with item table and totals in place |
| `Legacy-AI-Blank-Invoice.docx` | Blank invoice form with totals chain (subtotal → tax → total → paid → credit → due) |
| `Legacy-AI-Blank-Master.docx` | Blank master/brief form for proposals, scopes, updates |
| `Legacy-AI-Deck.pptx` | Brand presentation template — themed master with logo + contact footer, 5 starter slides |
| `Legacy-AI-Calculator.xlsx` | Quote/invoice math workbook — blue inputs on `Inputs`, live formulas, print-ready `Quote` and `Invoice` views; invoice due date = Net 7 expressed as a formula |

Filled ILLUSTRATIVE SAMPLE documents (fictional client "Juniper Bench Service Co."):
`.docx` + matching client-ready `.pdf` for Quote, Invoice, Letter, Master —
`Legacy-AI-Quote.docx/.pdf`, `Legacy-AI-Invoice.docx/.pdf`, `Legacy-AI-Letter.docx/.pdf`,
`Legacy-AI-Master.docx/.pdf`. The samples demonstrate the layouts with sample data;
remove the sample flag and substitute real facts only in copies.

## Regenerate or edit

Word documents come from JSON via the kit contract (unchanged shape):

```sh
tools/.venv/bin/python tools/generate_v2.py tools/quote.json out/Quote.docx
tools/.venv/bin/python tools/generate_v2.py --blank invoice out/Invoice-blank.docx
```

Rebuild the deck and workbook from source:

```sh
tools/.venv/bin/python tools/build_deck.py
tools/.venv/bin/python tools/build_workbook.py
```

In Word, type amounts into the forms and recheck totals by hand; in the workbook,
edit only the blue cells on `Inputs` — every other figure, including the invoice
Net-7 due date, is a formula. The v2 PDFs in this folder were rendered with
LibreOffice from exactly these files.

## Rules carried from the criteria

- One accent (forest #244337) on white; hairline ledger rules, no table grids.
- Money is right-aligned; column headings repeat on continued pages.
- Every filled sample keeps the ILLUSTRATIVE SAMPLE label until real facts replace it.
- Real named Word styles carry the design; do not restyle by hand.
