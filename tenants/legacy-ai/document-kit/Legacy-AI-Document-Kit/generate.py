"""Create an editable Legacy AI document from a JSON file or a blank form.

Usage:
    python generate.py examples/quote.json quote.docx
    python generate.py --blank invoice invoice-template.docx
"""

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path


KINDS = ("quote", "invoice", "letter", "brief")
TITLES = {"quote": "Quote", "invoice": "Invoice", "letter": "Letter", "brief": "Project brief"}
# The kit uses currencies with two minor-unit decimal places.
CURRENCY_SYMBOLS = {
    "USD": "$", "CAD": "CA$", "EUR": "€", "GBP": "£",
    "AUD": "A$", "NZD": "NZ$", "CHF": "CHF ",
}
COMMON_FIELDS = {
    "kind", "sample", "title", "reference", "date", "client", "subject", "intro",
    "sections", "signoff", "next_step",
}
FINANCIAL_FIELDS = {"until", "currency", "items", "tax", "terms"}
INVOICE_FIELDS = {"paid", "credit", "payment"}
CENT = Decimal("0.01")


class InputError(ValueError):
    """A correctable error in the input JSON."""


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InputError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def object_fields(value, allowed, path):
    if not isinstance(value, dict):
        raise InputError(f"{path} must be an object.")
    unknown = set(value) - allowed
    if unknown:
        raise InputError(f"Unknown field in {path}: {', '.join(sorted(unknown))}")
    return value


def string(value, path):
    if not isinstance(value, str):
        raise InputError(f"{path} must be text.")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", value):
        raise InputError(f"{path} contains characters that cannot be written to Word.")
    return value.strip()


def required_text(obj, key, path="document"):
    result = string(obj.get(key, ""), f"{path}.{key}")
    if not result:
        raise InputError(f"{path}.{key} is required.")
    return result


def rows(value, path):
    if not isinstance(value, list):
        raise InputError(f"{path} must be a list.")
    return value


def text_list(value, path):
    values = [string(entry, f"{path}[{i}]") for i, entry in enumerate(rows(value, path))]
    if any(not entry for entry in values):
        raise InputError(f"{path} contains an empty entry. Remove it or add the text.")
    return values


def iso_date(value, path):
    value = string(value, path)
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise InputError(f"{path} must use YYYY-MM-DD.")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise InputError(f"{path} is not a valid calendar date.") from exc


def display_date(value):
    return f"{value:%B} {value.day}, {value.year}"


def decimal_value(value, path, places):
    if not isinstance(value, (str, int, Decimal)) or isinstance(value, bool):
        raise InputError(f"{path} must be a nonnegative number.")
    text = str(value).strip()
    if not re.fullmatch(fr"[0-9]{{1,12}}(?:\.[0-9]{{1,{places}}})?", text):
        raise InputError(f"{path} must be nonnegative, with up to 12 whole digits and {places} decimal places.")
    return Decimal(text)


def money(value, symbol, rate=False):
    formatted = format(value, ",f")
    whole, _, fraction = formatted.partition(".")
    decimals = fraction.rstrip("0").ljust(2, "0") if rate else fraction.ljust(2, "0")[:2]
    return f"{symbol}{whole}.{decimals}"


def financial_context(src, kind, issued):
    currency = required_text(src, "currency").upper()
    if currency not in CURRENCY_SYMBOLS:
        raise InputError(f"currency must be one of {', '.join(CURRENCY_SYMBOLS)}.")
    symbol = CURRENCY_SYMBOLS[currency]
    raw_items = rows(src.get("items"), "items")
    if not raw_items:
        raise InputError("items must have at least one line.")
    if "tax" not in src:
        raise InputError("Supply the tax amount. Use 0 only when no tax applies.")
    tax = decimal_value(src["tax"], "tax", 2)
    items = []
    subtotal = Decimal(0)
    for i, raw in enumerate(raw_items):
        path = f"items[{i}]"
        item = object_fields(raw, {"description", "detail", "qty", "unit", "unit_price"}, path)
        qty = decimal_value(item.get("qty"), f"{path}.qty", 6)
        if qty <= 0:
            raise InputError(f"{path}.qty must be greater than zero.")
        rate = decimal_value(item.get("unit_price"), f"{path}.unit_price", 6)
        amount = (qty * rate).quantize(CENT, rounding=ROUND_HALF_UP)
        qty_display = format(qty.normalize(), "f")
        unit = string(item.get("unit", ""), f"{path}.unit")
        items.append({
            "description": required_text(item, "description", path),
            "detail": string(item.get("detail", ""), f"{path}.detail"),
            "qty": f"{qty_display} {unit}".strip(),
            "unit_price": money(rate, symbol, rate=True),
            "amount": money(amount, symbol),
        })
        subtotal += amount

    total = subtotal + tax
    totals = [{"label": "Subtotal", "amount": money(subtotal, symbol)},
              {"label": "Tax", "amount": money(tax, symbol)}]
    adjustments = [("credit", "Credit applied"), ("paid", "Payment received")]
    if kind == "invoice" and any(key in src for key, _ in adjustments):
        totals.append({"label": "Invoice total", "amount": money(total, symbol)})
        balance = total
        for key, label in adjustments:
            if key in src:
                value = decimal_value(src[key], key, 2)
                if value:
                    totals.append({"label": label, "amount": "−" + money(value, symbol)})
                balance -= value
        if balance < 0:
            totals.append({"label": "Credit balance", "amount": money(-balance, symbol)})
        totals.append({"label": "Amount due", "amount": money(max(balance, Decimal(0)), symbol)})
    else:
        label = "Quote total" if kind == "quote" else "Amount due"
        totals.append({"label": label, "amount": money(total, symbol)})
    until = ""
    if src.get("until") != "" and "until" in src:
        deadline = iso_date(src["until"], "until")
        if kind == "quote" and deadline < issued:
            raise InputError("A quote cannot expire before its issue date.")
        until = display_date(deadline)
    return {"items": items, "totals": totals, "currency": currency, "until": until,
            "payment": string(src.get("payment", ""), "payment")}


def normalize_document(src):
    if not isinstance(src, dict):
        raise InputError("The top level of the JSON must be an object.")
    kind = required_text(src, "kind")
    if kind not in KINDS:
        raise InputError(f"kind must be one of {', '.join(KINDS)}.")
    financial = kind in ("quote", "invoice")
    fields = COMMON_FIELDS | (FINANCIAL_FIELDS if financial else set())
    if kind == "letter":
        fields = fields | {"salutation"}
    object_fields(src, fields | (INVOICE_FIELDS if kind == "invoice" else set()), "document")
    if not isinstance(src.get("sample", False), bool):
        raise InputError("sample must be true or false.")
    client = object_fields(src.get("client"), {"name", "company", "address"}, "client")
    client = {"name": string(client.get("name", ""), "client.name"),
              "company": string(client.get("company", ""), "client.company"),
              "address": text_list(client.get("address", []), "client.address")}
    if not (client["name"] or client["company"]):
        raise InputError("Supply a client.name or a client.company.")
    issued = iso_date(src.get("date", ""), "date")
    reference = required_text(src, "reference") if financial else string(src.get("reference", ""), "reference")
    signoff = object_fields(src.get("signoff", {}), {"closing", "name", "role"}, "signoff")
    sections = []
    for i, section in enumerate(rows(src.get("sections", []), "sections")):
        path = f"sections[{i}]"
        object_fields(section, {"heading", "body"}, path)
        body = text_list(section.get("body", []), f"{path}.body")
        if not body:
            raise InputError(f"{path}.body must include at least one paragraph.")
        sections.append({"heading": string(section.get("heading", ""), f"{path}.heading"), "body": body})
    result = {
        "kind": kind, "blank": False, "sample": src.get("sample", False),
        "title": string(src.get("title", TITLES[kind]), "title") or TITLES[kind], "reference": reference,
        "date": display_date(issued), "client": client, "sections": sections,
        "signoff": {key: string(signoff.get(key, ""), f"signoff.{key}") for key in ("closing", "name", "role")},
        "terms": text_list(src.get("terms", []), "terms"),
        "items": [], "totals": [], "currency": "", "until": "", "payment": "",
    }
    for key in ("subject", "intro", "salutation", "next_step"):
        result[key] = string(src.get(key, ""), key)
    if kind in ("letter", "brief") and not any((result["intro"], sections, result["next_step"])):
        raise InputError(f"Supply intro, sections or next_step for the {kind}.")
    if financial:
        with localcontext() as ctx:
            ctx.prec = 64
            result.update(financial_context(src, kind, issued))
    return result


def blank_document(kind):
    data = {
        "kind": kind, "blank": True, "sample": False, "title": TITLES[kind],
        "reference": "[Reference]", "date": "[Issue date]",
        "client": {"name": "[Contact name]", "company": "[Client company]", "address": []},
        "subject": "[Project or service]", "intro": "[Opening paragraph]",
        "sections": [], "salutation": "", "signoff": {"closing": "", "name": "", "role": ""},
        "until": "", "currency": "", "items": [], "totals": [], "next_step": "",
        "terms": [], "payment": "",
    }
    if kind in ("quote", "invoice"):
        is_quote = kind == "quote"
        data.update({
            "intro": "[Describe the work covered by this quote.]" if is_quote else "[Describe the work or billing period.]",
            "until": "[Expiration date]" if is_quote else "[Due date]",
            "currency": "[Currency]",
            "items": [{"description": "[Service or deliverable]", "detail": "[Included work]",
                       "qty": "[Qty]", "unit_price": "[Rate]", "amount": "[Amount]"}],
            "totals": [{"label": "Subtotal", "amount": "[Subtotal]"}, {"label": "Tax", "amount": "[Tax]"}],
        })
        if is_quote:
            data["totals"].append({"label": "Quote total", "amount": "[Total]"})
            data["terms"] = ["[Approved timeline and terms.]"]
            data["next_step"] = "[How the client can approve the work.]"
        else:
            data["totals"].extend([{"label": "Invoice total", "amount": "[Total]"},
                                   {"label": "Credit applied", "amount": "[Credit]"},
                                   {"label": "Payment received", "amount": "[Paid]"},
                                   {"label": "Amount due", "amount": "[Balance]"}])
            data["payment"] = "[Agreed payment instructions.]"
    elif kind == "letter":
        data.update({
            "reference": "", "subject": "[Subject of letter]",
            "client": {**data["client"], "address": ["[Street or PO box]", "[City, state and postal code]"]},
            "salutation": "Dear [name],", "intro": "[State the reason for writing.]",
            "sections": [{"heading": "", "body": ["[Explain the details and what the recipient needs to know.]",
                                                      "[State the next step and who will handle it.]"]}],
            "signoff": {"closing": "Sincerely,", "name": "[Sender name]", "role": "[Role], Legacy AI"},
        })
    else:
        data.update({
            "title": "[Document title]", "subject": "[Project or engagement]",
            "intro": "[Summarize the purpose and outcome for the reader.]",
            "sections": [{"heading": "[Section heading]", "body": ["[Add the details the reader needs.]"]},
                         {"heading": "[Section heading]", "body": ["[Describe a decision, deliverable or responsibility.]"]}],
            "next_step": "[State who will do what and by when.]",
        })
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate an editable Legacy AI Word document.")
    parser.add_argument("--blank", choices=KINDS, metavar="TYPE", help="make a blank quote, invoice, letter or brief")
    parser.add_argument("input", nargs="?", type=Path, help="path to the JSON document")
    parser.add_argument("output", type=Path, help="output .docx path")
    args = parser.parse_args(argv)
    if (args.blank is None) == (args.input is None):
        parser.error("Supply either an input JSON file or --blank TYPE.")
    if args.output.suffix.lower() != ".docx":
        parser.error("The output filename must end with .docx.")
    if args.input and args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files.")
    tmp_path = None
    try:
        if args.blank:
            doc = blank_document(args.blank)
        else:
            with args.input.open(encoding="utf-8-sig") as source:
                raw = json.load(source, parse_float=Decimal, object_pairs_hook=strict_object)
            doc = normalize_document(raw)
        from build_layout import render_document
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".docx", delete=False) as temp:
            tmp_path = Path(temp.name)
        render_document(doc, tmp_path)
        os.replace(tmp_path, args.output)
    except ModuleNotFoundError as exc:
        print(f"Missing component: {exc.name}. Use the complete kit and install python-docx.", file=sys.stderr)
        return 1
    except (InputError, json.JSONDecodeError, OSError, UnicodeError) as exc:
        print(f"Cannot generate document: {exc}", file=sys.stderr)
        return 1
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
