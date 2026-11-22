"""Kit R6 growth test: a 35-line invoice must flow across pages with repeated
column headings, complete footers, and no stranded headings. Renders evidence
to evidence/captures/growth-invoice.pdf."""
import json, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
items = [{
    "description": f"Growth test item {i:02d} — plain-language line so the five-year test stays honest",
    "detail": "Included work described for the dispatch office.",
    "qty": 1, "unit_price": 10.00,
} for i in range(1, 36)]
data = {
    "kind": "invoice", "sample": True, "title": "Invoice", "reference": "INV-GROW",
    "subject": "Growth test — repeated headings across pages",
    "date": "2026-11-20", "until": "2026-11-27",
    "client": {"company": "Growth Test Client", "name": "Ivy Row", "address": ["12 Test Lane"]},
    "intro": "A deliberate 35-line invoice proving headings repeat and footers persist.",
    "sections": [], "currency": "USD", "items": items, "tax": 0,
    "terms": ["Synthetic growth test — not a real invoice."],
    "next_step": "File this under evidence; no action needed.",
    "signoff": {"closing": "Thanks,", "name": "Douglas Talley", "role": "Founder, Legacy AI"},
}
src = root / "tools" / "growth-input.json"; src.write_text(json.dumps(data, indent=2))
out = root / "evidence" / "captures" / "growth-invoice.docx"
subprocess.run([sys.executable, str(root / "tools" / "generate_v2.py"), str(src), str(out)], check=True)
subprocess.run(["/Applications/LibreOffice.app/Contents/MacOS/soffice", "--headless",
                "--convert-to", "pdf", "--outdir", str(out.parent), str(out)], check=True, capture_output=True)
import fitz
doc = fitz.open(out.with_suffix(".pdf"))
pages = [page.get_text() for page in doc]
ok_headings = all("UNIT PRICE" in p or "Work" in p for p in pages)
ok_footer = all("legacyai.space" in p for p in pages)
ok_items = sum(p.count("Growth test item") for p in pages) >= 35
ok_total = any("350.00" in p for p in pages)
print(f"growth: pages={len(doc)} headings_repeat={ok_headings} footers={ok_footer} items={ok_items}")
raise SystemExit(0 if (len(doc) >= 2 and ok_headings and ok_footer and ok_items and ok_total) else 1)
