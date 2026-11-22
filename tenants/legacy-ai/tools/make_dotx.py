"""Convert the blank letterhead .docx into a true Word template (.dotx)."""
import shutil, zipfile, sys
from pathlib import Path
src = Path(sys.argv[1]); dst = Path(sys.argv[2])
tmp = dst.with_suffix(".tmp")
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "[Content_Types].xml":
            data = zin.read(item.filename).decode("utf-8").replace(
                "wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml").encode("utf-8")
        zout.writestr(item, data)
shutil.move(str(tmp), str(dst))
print(dst)
