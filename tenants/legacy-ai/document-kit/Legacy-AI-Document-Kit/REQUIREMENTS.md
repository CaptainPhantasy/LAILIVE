# Legacy AI stationery

Prepared November 20, 2026. The original request covers reusable business documents and a new logo. The requirements below record the working decisions for this edition.

| ID | Required result | Design decision or assumption | Check |
|---|---|---|---|
| R1 | Reflect the existing business and its voice. | The public Legacy AI site is the source for brand spelling, founder, contacts and service language. Use short explanations that an owner can act on. | Compare names and contacts with the public site and read the finished sample pages. |
| R2 | Supply an original logo at a restrained size. | Use a new open-folio and rolling-hills mark with an editorial wordmark. Choose deep forest ink and keep room around the masthead. | Inspect the new artwork on a printed-size page and at high magnification. |
| R3 | Reuse one master across quotes, invoices, company correspondence and related documents. | Use editable Word documents on US Letter, plus a blank stationery template. | Open each variant through the document renderer and inspect the resulting page. |
| R4 | Let an LLM prepare new documents without redesigning them. | Provide a copyable prompt for document-capable models and a structured JSON option for models with code execution. | Generate each example from its input and verify text, styling and example status. |
| R5 | Keep money figures and business terms accurate. | Calculate the structured version with decimal arithmetic. Client details, prices, tax, credits and deadlines come from the job record. | Check a fractional-quantity case, displayed totals and rejection of malformed inputs. |
| R6 | Preserve the design as content grows. | Let paragraphs and amounts flow naturally and repeat item headings on a continued table. | Render a long document and a multi-page item list. Inspect continuation pages and footer placement. |

## Brand references

Checked November 20, 2026. The public homepage identifies the founder and contact details. The field guide shows how the company discusses missed calls, booking, handoffs and scope in the owner's language.

- [Legacy AI](https://legacyai.space/)
- [Legacy AI field guide](https://legacyai.space/catalog.pdf)

## Release checks

| Requirement | Evidence recorded November 20, 2026 |
|---|---|
| R1 | The rendered footer matches the domain, email, number and county published on the homepage. The fictional job follows a missed call through to the dispatcher's callback. |
| R2 | The open-folio mark and wordmark are supplied as three font-independent SVG paths and a 2070 × 338 transparent PNG. The Word masthead is 1.92 inches wide. |
| R3 | Rendered and reviewed four editable Word shells, four filled examples and the blank Word stationery template. Each opening example fits one 8.5 × 11 inch sheet. |
| R4 | Reopened the ZIP, extracted it to a new folder and generated each of the four document types there. The PDF preview has four pages and four bookmarks. |
| R5 | The example quote sums to $950.00. The invoice applies $250.00 received and shows $700.00 due. Separate input checks exercised rounding, credit, overpayment and invalid data. |
| R6 | A 35-line invoice rendered across four pages. Every item appeared once, and the column headings repeated on each page. A 19-paragraph letter rendered across three pages with all paragraphs present. Both tests preserved the logo and page-number field. |
