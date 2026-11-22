# Use the Legacy AI document kit

For a new job, give your LLM the matching Word file from `templates`, the prompt below, and your job notes. The master works for proposals, project updates, scopes of work and other documents with a title and sections. The quote and invoice already have the item table and totals in place.

## Copy this prompt

> Make a new Legacy AI document from the attached Word template and my notes. Preserve the logo, masthead, footer, margins, typography and page size. Return an editable Word file. If you can export PDF, also return the client-ready PDF.
>
> Write like Douglas is talking to the owner who has to use this. Name the work, say what the customer receives, and give them one clear next step. Use ordinary shop and office language. Only describe results, dates, terms or commitments supported by my notes.
>
> For a quote, identify what is included, what it costs, and how to approve it. For an invoice, identify what was supplied, any payments already received, and the balance due. For a letter, put the reason for writing in the opening paragraph and sign with the name I provide. For another document, choose headings that fit the job.
>
> Use only the client, job and money details I supply. Ask me for any missing detail that changes the price, due date, tax treatment, payment destination or commitment. Leave the document as a draft until those questions are resolved. Remove unused sections and all placeholder text before making a client-ready copy. Recalculate the figures and inspect the exported pages for wrap, cutoff or a stranded heading.
>
> My document type and job notes follow.

## Work in Word

Open a copy of the closest Word document. Replace bracketed fields and duplicate the item row for each service. When you type amounts directly into Word, update and check the totals yourself. For a clean sheet, open `templates/Legacy-AI-Letterhead.dotx` in Word. Its header and footer follow the text as you add pages.

## Generate from a job record

The files in `examples` show the exact input shape for each kind of document. All four use a fictional client and carry a sample label. Give your model the relevant JSON file as a format example. Have it replace the example facts with the actual job, remove the sample flag for approved real content, and save the new JSON separately. The generator does the arithmetic, adds the logo and returns an editable Word document.

From the unpacked kit folder, with Python 3.10 or newer installed, run

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'python-docx>=1.1,<2'
.venv/bin/python generate.py examples/quote.json Quote.docx
```

On Windows, use `.venv\Scripts\python.exe` for the last two commands. Replace the example input path with your job file and choose a fresh output name. Use Word's Export or Save As PDF command for the client copy.

## Artwork and samples

The `assets` folder holds the forest-green logo as a transparent PNG for office files and an SVG for print or resizing. The completed sample pages are in `Legacy-AI-Samples.pdf`. The design uses white paper with a small repeating masthead and an editable document body.

Brand and contact details checked November 20, 2026 against [Legacy AI](https://legacyai.space/).

## Financial inputs

For quotes and invoices, supply a reference, issue date, client, currency, item quantities and unit prices, and the actual tax amount. Use zero for tax only when confirmed. Dates in JSON use `YYYY-MM-DD`. The optional `until` is the quote expiration date or the invoice payment deadline. Optional invoice fields include `paid` for a payment received, `credit` for a credit applied, and `payment` for the agreed payment instructions. The generator rounds each line to cents before summing. Monetary examples in this kit are fictional.
