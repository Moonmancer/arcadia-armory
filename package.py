# Baut das Addon-Paket.
#
#   python package.py
#
# Legt build/ mit genau den Dateien an, die ins Addon gehoeren, und packt sie
# zu arcadia-armory.xpi. build/ dient ausserdem als Eingabe fuer den Linter,
# damit der genau das prueft, was auch hochgeladen wird:
#
#   npx web-ext lint --source-dir build --self-hosted
#
# Wichtig: manifest.json muss im Archiv auf oberster Ebene liegen, sonst
# lehnt addons.mozilla.org das Paket ab.
import hashlib
import json
import os
import shutil
import zipfile

FILES = [
    "manifest.json",
    "icons/icon.svg",
    "src/bridge.js",
    "src/page.js",
    "src/woe-blacklist.js",
    "src/cp.js",
    "src/panel.css",
    "src/theme-armory.css",
    "src/cp.css",
]
BUILD = "build"
XPI = "arcadia-armory.xpi"

here = os.path.dirname(os.path.abspath(__file__))
os.chdir(here)

for f in FILES:
    if not os.path.exists(f):
        raise SystemExit("fehlt: " + f)

# Alles, worauf das Manifest verweist, muss auch im Paket sein.
with open("manifest.json", encoding="utf-8") as fh:
    manifest = json.load(fh)
referenced = set(manifest.get("icons", {}).values())
for cs in manifest.get("content_scripts", []):
    referenced.update(cs.get("js", []) + cs.get("css", []))
missing = sorted(referenced - set(FILES))
if missing:
    raise SystemExit("im Manifest referenziert, aber nicht in FILES: " + ", ".join(missing))

shutil.rmtree(BUILD, ignore_errors=True)
for f in FILES:
    os.makedirs(os.path.join(BUILD, os.path.dirname(f)), exist_ok=True)
    shutil.copy2(f, os.path.join(BUILD, f))

with zipfile.ZipFile(XPI, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(f, f.replace(os.sep, "/"))

data = open(XPI, "rb").read()
print("%s  Version %s" % (manifest["name"], manifest["version"]))
print()
for f in FILES:
    print("  %-22s %7d Bytes" % (f, os.path.getsize(f)))
print()
print("%s: %d Bytes" % (XPI, len(data)))
print("sha256: %s" % hashlib.sha256(data).hexdigest())
print()
print("Naechster Schritt:")
print("  npx web-ext lint --source-dir %s --self-hosted" % BUILD)
