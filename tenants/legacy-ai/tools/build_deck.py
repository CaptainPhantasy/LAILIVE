"""Build Legacy-AI-Deck.pptx — the tenant's brand presentation template.

v2 (post adversarial visual review): true 16:9 grid with one shared left margin,
explicit Georgia/Arial on every run (no per-layout font inheritance), slide
numbers, county in the footer, forest ledger hairline on content layouts, and
sentence-case starter copy with the brand's typographic apostrophe.
"""
import re
import shutil
import zipfile
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from lxml import etree

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "document-kit" / "Legacy-AI-Document-Kit" / "assets" / "legacy-ai-lockup.png"
OUT = ROOT / "templates" / "Legacy-AI-Deck.pptx"

FOREST = RGBColor(0x24, 0x43, 0x37)
INK = RGBColor(0x1D, 0x28, 0x22)
MUTED = RGBColor(0x4C, 0x5C, 0x51)
GRID = Inches(0.55)          # the one left margin
WIDTH = Inches(12.23)        # content width on 13.333 - 2*0.55
LEFT_EMU, TOP_EMU = 5003, 280  # master logo position (EMU ≈ 0.55in, 0.29in)
LOGO_W = 1412430             # ≈ 1.55in


def inject_logo(container, part, image_path, left_emu, top_emu, width_emu):
    image_part = part.package.get_or_add_image_part(str(image_path))
    r_id = part.relate_to(image_part, RT.IMAGE)
    from PIL import Image
    with Image.open(str(image_path)) as im:
        ratio = im.height / im.width
    xml = (
        '<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:nvPicPr><p:cNvPr id="901" name="Legacy AI logo" descr="Legacy AI"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
        '<p:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
        % (r_id, left_emu, top_emu, width_emu, int(width_emu * ratio))
    )
    container.shapes._spTree.append(etree.fromstring(xml))


def inject_rule(container, left_emu, top_emu, width_emu, color_hex="244337"):
    """A forest ledger hairline across the layout, above the footer."""
    xml = (
        '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<p:nvSpPr><p:cNvPr id="903" name="Ledger hairline"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="12700"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        '<p:ln w="12700"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></p:ln></p:sp>'
        % (left_emu, top_emu, width_emu, color_hex)
    )
    container.shapes._spTree.append(etree.fromstring(xml))


def inject_text(container, left_emu, top_emu, width_emu, height_emu, runs, align="l"):
    """runs: list of (text, size_pt, color_hex, font, bold)."""
    paragraphs = "".join(
        '<a:p><a:pPr algn="%s"/><a:r><a:rPr lang="en-US" sz="%d" b="%d" dirty="0">'
        '<a:solidFill><a:srgbClr val="%s"/></a:solidFill><a:latin typeface="%s"/></a:rPr>'
        '<a:t>%s</a:t></a:r></a:p>' % (align, int(size * 100), 1 if bold else 0, color, font, text)
        for text, size, color, font, bold in runs
    )
    xml = (
        '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<p:nvSpPr><p:cNvPr id="902" name="Contact footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr><a:lstStyle/>%s</p:txBody></p:sp>'
        % (left_emu, top_emu, width_emu, height_emu, paragraphs)
    )
    container.shapes._spTree.append(etree.fromstring(xml))


def inject_slide_number(slide, number):
    xml = (
        '<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:nvSpPr><p:cNvPr id="904" name="Slide number"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>'
        '<p:ph type="sldNum" sz="quarter" idx="4294967295"/></p:nvPr></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="12153600" y="6480000"/><a:ext cx="720000" cy="360000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{2B44CF13-2CAB-4D0E-9C4A-6E2E1F0B9%s}" type="slidenum">'
        '<a:rPr lang="en-US" sz="900"><a:solidFill><a:srgbClr val="4C5C51"/></a:solidFill>'
        '<a:latin typeface="Arial"/></a:rPr><a:t>%d</a:t></a:fld></a:p></p:txBody></p:sp>'
        % ("0" + str(number), number)
    )
    slide.shapes._spTree.append(etree.fromstring(xml))


def reposition(slide_or_layout, mapping):
    """mapping: idx -> (left, top, width, height)."""
    for ph in slide_or_layout.placeholders:
        if ph.placeholder_format.idx in mapping:
            left, top, width, height = mapping[ph.placeholder_format.idx]
            ph.left, ph.top, ph.width, ph.height = left, top, width, height


prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

master = prs.slide_masters[0]
inject_logo(master, master.part, ASSETS, LEFT_EMU, TOP_EMU, LOGO_W)
inject_text(master, GRID, Inches(7.02), Inches(11.5), Inches(0.32),
            [("legacyai.space   ·   douglas@legacyai.space   ·   812-412-3454   ·   Brown County, Indiana",
              9, "4C5C51", "Arial", False)])

TITLE_LAYOUT, SECTION_LAYOUT, CONTENT_LAYOUT, TWO_LAYOUT = prs.slide_layouts[0], prs.slide_layouts[2], prs.slide_layouts[1], prs.slide_layouts[3]
reposition(TITLE_LAYOUT, {0: (GRID, Inches(2.45), WIDTH, Inches(1.5)), 1: (GRID, Inches(4.15), WIDTH, Inches(1.3))})
reposition(SECTION_LAYOUT, {0: (GRID, Inches(2.75), WIDTH, Inches(1.2)), 1: (GRID, Inches(4.1), WIDTH, Inches(1.2))})
reposition(CONTENT_LAYOUT, {0: (GRID, Inches(0.95), WIDTH, Inches(1.05)), 1: (GRID, Inches(2.25), WIDTH, Inches(4.4))})
reposition(TWO_LAYOUT, {0: (GRID, Inches(0.95), WIDTH, Inches(1.05)),
                        1: (GRID, Inches(2.25), Inches(5.95), Inches(4.4)),
                        2: (Inches(6.83), Inches(2.25), Inches(5.95), Inches(4.4))})
for layout in (CONTENT_LAYOUT, SECTION_LAYOUT, TWO_LAYOUT):
    inject_rule(layout, GRID, Inches(6.82), WIDTH)

def style_title(slide, color=INK, size=None, font="Georgia"):
    for para in slide.shapes.title.text_frame.paragraphs:
        for run in para.runs:
            run.font.name = font
            run.font.color.rgb = color
            if size:
                run.font.size = Pt(size)

def style_body(placeholder, color=INK, font="Arial"):
    for para in placeholder.text_frame.paragraphs:
        for run in para.runs:
            run.font.name = font
            run.font.color.rgb = color

# Title slide
s = prs.slides.add_slide(TITLE_LAYOUT)
s.shapes.title.text = "Legacy AI"
s.placeholders[1].text = "We don’t sell technology. We sell results."
style_title(s, INK, 54)
style_body(s.placeholders[1], FOREST)
s.placeholders[1].text_frame.paragraphs[0].runs[0].font.size = Pt(24)

# Section slide (built on the known-good title layout; the section layout's
# placeholder carries its own caps/font quirks that break the two-family rule)
s = prs.slides.add_slide(TITLE_LAYOUT)
s.shapes.title.text = "What we build"
s.placeholders[1].text = "54 ready-made solutions, already in production"
style_title(s, FOREST, 40)
style_body(s.placeholders[1], MUTED)
s.placeholders[1].text_frame.paragraphs[0].runs[0].font.size = Pt(20)
inject_rule(s, GRID, Inches(6.82), WIDTH)

# Content slide
s = prs.slides.add_slide(CONTENT_LAYOUT)
s.shapes.title.text = "Fill the calendar"
style_title(s, INK, 32)
tf = s.placeholders[1].text_frame
tf.text = "Phones answered 24/7, first ring, under two seconds"
for line in ("AI receptionist and live booking calendar",
             "Missed-call text-backs and follow-ups",
             "Review harvesting and lead capture"):
    tf.add_paragraph().text = line
style_body(s.placeholders[1])

# Two-content slide
s = prs.slides.add_slide(TWO_LAYOUT)
s.shapes.title.text = "Quote → approval → invoice"
style_title(s, INK, 32)
left, right = s.placeholders[1].text_frame, s.placeholders[2].text_frame
left.text = "What the client receives"
for line in ("Itemized work with plain descriptions", "One total, one next step"):
    left.add_paragraph().text = line
right.text = "What Legacy AI receives"
for line in ("Approved scope, frozen", "A payable invoice tied to the quote"):
    right.add_paragraph().text = line
style_body(s.placeholders[1])
style_body(s.placeholders[2])

# Closing slide
s = prs.slides.add_slide(TITLE_LAYOUT)
s.shapes.title.text = "Douglas Talley"
s.placeholders[1].text = "Founder, Legacy AI — Brown County, Indiana"
style_title(s, INK, 44)
style_body(s.placeholders[1], FOREST)
s.placeholders[1].text_frame.paragraphs[0].runs[0].font.size = Pt(24)

for number, slide in enumerate(prs.slides, start=1):
    inject_slide_number(slide, number)

prs.save(str(OUT))

# Theme surgery: save the tenant palette and font pair into theme1.xml.
FOREST_HEX, INK_HEX, MUTED_HEX, PALE_HEX = "244337", "1D2822", "4C5C51", "E9EDE6"
tmp = OUT.with_suffix(".tmp.pptx")
with zipfile.ZipFile(OUT) as source, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as target:
    for item in source.infolist():
        data = source.read(item.filename)
        if item.filename == "ppt/theme/theme1.xml":
            text = data.decode("utf-8")
            scheme = re.search(r'<a:clrScheme.*?</a:clrScheme>', text, re.S).group(0)
            patched = re.sub(r'<a:dk2>.*?</a:dk2>', f'<a:dk2><a:srgbClr val="{INK_HEX}"/></a:dk2>', scheme, flags=re.S)
            patched = re.sub(r'<a:lt2>.*?</a:lt2>', f'<a:lt2><a:srgbClr val="{PALE_HEX}"/></a:lt2>', patched, flags=re.S)
            patched = re.sub(r'<a:accent1>.*?</a:accent1>', f'<a:accent1><a:srgbClr val="{FOREST_HEX}"/></a:accent1>', patched, flags=re.S)
            patched = re.sub(r'<a:accent2>.*?</a:accent2>', f'<a:accent2><a:srgbClr val="{MUTED_HEX}"/></a:accent2>', patched, flags=re.S)
            text = text.replace(scheme, patched, 1)
            text = re.sub(r'(<a:majorFont><a:latin typeface=")[^"]*(")', r'\1Georgia\2', text, count=1)
            text = re.sub(r'(<a:minorFont><a:latin typeface=")[^"]*(")', r'\1Arial\2', text, count=1)
            data = text.encode("utf-8")
        target.writestr(item, data)
shutil.move(str(tmp), str(OUT))
print(OUT)
