# A better day's work.

The illustrated Legacy AI field guide, 2026. This source package is independent of the website design.

## Rebuild

Use Python 3.10 or newer in a virtual environment.

```sh
python -m pip install -r requirements.txt
python build.py --output /path/to/your/output/legacy-ai-solutions-field-guide.pdf
python verify.py /path/to/your/output/legacy-ai-solutions-field-guide.pdf
```

The output path is required. Assets and content are resolved relative to the build script, so the folder can move to a repository unchanged. The scripts also write layout and verification receipts beside themselves; these are ignored by Git.

## Visual verification

Use Poppler to render the PDF, then inspect every page after layout changes:

```sh
pdftoppm -scale-to 1100 -png /path/to/your/output/legacy-ai-solutions-field-guide.pdf /path/to/your/output/page
```

The automated verifier checks all 54 service names, current terms, links and text bounds. It complements visual inspection and does not replace it.

## Contents

- `build.py`: the page layout and finished guide text.
- `editorial.py`: chapter introductions, selection guidance, navigation and industry applications.
- `services.json`: all 54 current service names, descriptions and route identifiers.
- `assets/`: six optimized illustrations, static Source Serif and Inter fonts, and font licenses.
- `generation-manifest.json`: six original prompts; built-in image generation, one call per asset, no retries. Full-resolution PNG originals were delivered separately in `catalog-field-guide-assets`.
- `verify.py`: PDF content, link and boundary checks.

Functional routes use `https://legacyai.space`. The illustration series uses petrol blue, copper and warm white, with small forest accents. The guide uses no website photographs, Cormorant headlines, stacked cards or category tabs.
