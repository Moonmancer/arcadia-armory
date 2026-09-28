# Veroeffentlicht eine von Mozilla signierte .xpi als GitHub-Release und
# traegt sie in updates.json ein, damit Firefox das Update automatisch findet.
#
#   python release.py                 Probelauf
#   python release.py --sign          vorher bauen und bei AMO signieren lassen
#   python release.py --publish       veroeffentlichen
#   python release.py <datei> ...     bestimmte signierte Datei verwenden
#
# Ohne Dateiangabe sucht das Skript die signierte .xpi der Version aus
# manifest.json selbst: in dist/<version>/, im Projektordner und im
# Downloads-Ordner (der Dateiname von AMO ist egal, geprueft werden Id,
# Version und Signatur). Sie landet als dist/<version>/arcadia-armory-<version>.xpi
# neben der unsignierten Fassung von package.py.
#
# Ohne --publish passiert nichts nach aussen: das Skript prueft die Datei,
# schreibt dist/ und updates.json und zeigt, was es tun wuerde.
#
# --sign baut das Paket (package.py) und laesst build/ ueber die AMO-API als
# unlisted signieren (npx web-ext sign). Die Zugangsdaten kommen aus den
# Umgebungsvariablen WEB_EXT_API_KEY / WEB_EXT_API_SECRET, unter Windows
# notfalls direkt aus den gespeicherten Benutzer-Variablen. Jede Version
# laesst sich nur einmal signieren; liegt schon eine signierte Datei vor,
# wird nicht erneut signiert. Ist die Version bei AMO schon eingereicht
# (auch von Hand hochgeladen), laedt --sign die signierte Datei ueber die API
# nach dist/<version>/ (sha256 wird gegen AMO geprueft).
#
# Reihenfolge im Gesamtablauf:
#   1. version in manifest.json erhoehen
#   2. python release.py --sign               bauen, signieren, Probelauf
#   3. python release.py --publish            veroeffentlichen
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
UPDATES = os.path.join(HERE, "updates.json")


def fail(msg):
    raise SystemExit("abgebrochen: " + msg)


def run(cmd, **kw):
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd, check=True, **kw)


def version_key(v):
    return tuple(int(x) for x in re.findall(r"\d+", v))


def repo_slug():
    """owner/repo aus der git-Remote lesen, damit nichts hart verdrahtet ist."""
    url = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=HERE, capture_output=True, text=True, check=True,
    ).stdout.strip()
    m = re.search(r"github\.com[:/](.+?)(?:\.git)?$", url)
    if not m:
        fail("origin zeigt nicht auf GitHub: " + url)
    return m.group(1)


def read_manifest_from_xpi(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "manifest.json" not in names:
            fail("kein manifest.json auf oberster Ebene in " + path)
        signed = any(n.startswith("META-INF/") for n in names)
        return json.loads(z.read("manifest.json").decode("utf-8")), signed


def api_credentials():
    """AMO-Zugangsdaten aus der Umgebung, unter Windows notfalls aus den
    Benutzer-Variablen (die ein schon laufender Prozess noch nicht sieht)."""
    names = ("WEB_EXT_API_KEY", "WEB_EXT_API_SECRET")
    creds = {n: os.environ.get(n, "") for n in names}
    if not all(creds.values()) and sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                for n in names:
                    if not creds[n]:
                        try:
                            creds[n] = winreg.QueryValueEx(key, n)[0]
                        except OSError:
                            pass
        except OSError:
            pass
    missing = [n for n in names if not creds[n]]
    if missing:
        fail("AMO-Zugangsdaten fehlen: " + ", ".join(missing) + "\n"
             "  Schluessel unter https://addons.mozilla.org/developers/addon/api/key/ erzeugen.")
    return creds


AMO_API = "https://addons.mozilla.org/api/v5"


def amo_request(url, creds):
    """GET gegen die AMO-API mit kurzlebigem JWT (HS256)."""
    def b64(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=")
    now = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims = {"iss": creds["WEB_EXT_API_KEY"], "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}
    body = b64(json.dumps(claims).encode())
    sig = b64(hmac.new(creds["WEB_EXT_API_SECRET"].encode(), head + b"." + body, hashlib.sha256).digest())
    token = (head + b"." + body + b"." + sig).decode()
    req = urllib.request.Request(url, headers={"Authorization": "JWT " + token, "User-Agent": "ArcadiaArmory release.py"})
    return urllib.request.urlopen(req, timeout=60)


def amo_version(version, addon_id, creds):
    """Die Version bei AMO (auch unlisted) oder None, wenn sie nicht eingereicht ist."""
    url = "%s/addons/addon/%s/versions/?filter=all_with_unlisted&page_size=50" % (AMO_API, addon_id)
    try:
        with amo_request(url, creds) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:  # Add-on noch nie eingereicht
            return None
        raise
    return next((v for v in data.get("results", []) if v.get("version") == version), None)


def fetch_signed(version, addon_id, creds):
    """Laedt die signierte Datei einer bei AMO eingereichten Version nach
    dist/<version>/. True, wenn sie jetzt dort liegt; False, wenn die Version
    bei AMO nicht existiert."""
    v = amo_version(version, addon_id, creds)
    if not v:
        return False
    f = v.get("file") or {}
    if f.get("status") != "public" or not f.get("url"):
        fail("Version %s ist bei AMO eingereicht, aber noch nicht signiert (Status: %s).\n"
             "  Spaeter noch einmal mit --sign versuchen." % (version, f.get("status")))
    target = os.path.join(DIST, version, "arcadia-armory-%s.xpi" % version)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    print("signierte Datei von AMO laden:")
    print("  " + f["url"])
    with amo_request(f["url"], creds) as r:
        data = r.read()
    expected = (f.get("hash") or "").replace("sha256:", "")
    digest = hashlib.sha256(data).hexdigest()
    if expected and digest != expected:
        fail("Download beschaedigt: sha256 %s statt %s" % (digest, expected))
    with open(target, "wb") as fh:
        fh.write(data)
    print("  -> %s (%d Bytes)" % (target, len(data)))
    return True


def sign(version, addon_id):
    """Holt die signierte Datei von AMO, wenn die Version dort schon
    eingereicht ist; sonst Paket bauen und build/ als unlisted signieren."""
    try:
        existing = find_signed(version, addon_id)
    except SystemExit:
        existing = None
    if existing:
        print("schon signiert: %s - ueberspringe das Signieren" % existing)
        return
    creds = api_credentials()
    if fetch_signed(version, addon_id, creds):
        return
    npx = shutil.which("npx")
    if not npx:
        fail("npx nicht gefunden - Node.js installieren")
    print("Paket bauen:")
    run([sys.executable, "package.py"], stdout=subprocess.DEVNULL)
    print("bei AMO signieren (unlisted, dauert meist ein paar Minuten):")
    out_dir = os.path.join(DIST, version)
    # Zugangsdaten nur ueber die Umgebung, nie auf der Kommandozeile.
    run([npx, "--yes", "web-ext@8", "sign", "--channel=unlisted",
         "--source-dir", "build", "--artifacts-dir", out_dir],
        env={**os.environ, **creds})


def find_signed(version, addon_id):
    """Neueste signierte .xpi dieser Version/Id in dist/<version>/, im
    Projektordner oder im Downloads-Ordner."""
    dirs = [os.path.join(DIST, version), HERE, os.path.join(os.path.expanduser("~"), "Downloads")]
    found = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            path = os.path.join(d, name)
            if not name.endswith(".xpi") or name.endswith("-unsigned.xpi") or not os.path.isfile(path):
                continue
            try:
                m, signed = read_manifest_from_xpi(path)
            except (zipfile.BadZipFile, SystemExit, KeyError, ValueError):
                continue
            gid = m.get("browser_specific_settings", {}).get("gecko", {}).get("id")
            if signed and m.get("version") == version and gid == addon_id:
                found.append(path)
    if not found:
        fail("keine signierte .xpi fuer Version %s gefunden (gesucht in: %s)"
             % (version, ", ".join(dirs)))
    return max(found, key=os.path.getmtime)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xpi", nargs="?", help="die von Mozilla signierte .xpi (sonst wird gesucht)")
    ap.add_argument("--sign", action="store_true",
                    help="vorher bauen und ueber die AMO-API signieren lassen")
    ap.add_argument("--publish", action="store_true",
                    help="Release wirklich anlegen und updates.json pushen")
    ap.add_argument("--allow-unsigned", action="store_true",
                    help="Sicherheitsabfrage auf die Signatur uebergehen")
    args = ap.parse_args()
    os.chdir(HERE)

    with open("manifest.json", encoding="utf-8") as fh:
        local = json.load(fh)
    if args.sign:
        if args.xpi:
            fail("--sign und eine Dateiangabe schliessen sich aus")
        sign(local["version"], local["browser_specific_settings"]["gecko"]["id"])
    if not args.xpi:
        args.xpi = find_signed(local["version"], local["browser_specific_settings"]["gecko"]["id"])
        print("gefunden : %s" % args.xpi)
    if not os.path.isfile(args.xpi):
        fail("Datei nicht gefunden: " + args.xpi)

    signed_manifest, is_signed = read_manifest_from_xpi(args.xpi)

    gecko = local["browser_specific_settings"]["gecko"]
    addon_id = gecko["id"]
    version = signed_manifest["version"]

    # --- Plausibilitaet, bevor irgendetwas nach aussen geht ----------------
    if not is_signed and not args.allow_unsigned:
        fail("in der .xpi fehlt META-INF/ - das ist die unsignierte Datei.\n"
             "  Die signierte liegt in der AMO-Entwicklerecke unter Versions.\n"
             "  Mit --allow-unsigned laesst sich das uebergehen.")
    if signed_manifest["browser_specific_settings"]["gecko"]["id"] != addon_id:
        fail("die id in der .xpi passt nicht zu manifest.json")
    if version != local["version"]:
        fail("Version in der .xpi (%s) weicht von manifest.json (%s) ab"
             % (version, local["version"]))
    if "update_url" not in gecko:
        fail("manifest.json hat keine update_url - ohne die sucht Firefox nie")

    slug = repo_slug()
    tag = "v" + version
    asset = "arcadia-armory-%s.xpi" % version

    # dist/<version>/ haelt beide Fassungen: -unsigned (package.py) und signiert.
    target_dir = os.path.join(DIST, version)
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, asset)
    if os.path.abspath(args.xpi) != os.path.abspath(target):
        if os.path.dirname(os.path.abspath(args.xpi)) == os.path.abspath(target_dir):
            os.replace(args.xpi, target)  # z. B. die von web-ext benannte Datei
        else:
            shutil.copy2(args.xpi, target)
    digest = hashlib.sha256(open(target, "rb").read()).hexdigest()
    link = "https://github.com/%s/releases/download/%s/%s" % (slug, tag, asset)

    # --- updates.json fortschreiben ---------------------------------------
    with open(UPDATES, encoding="utf-8") as fh:
        updates = json.load(fh)
    entries = updates.setdefault("addons", {}).setdefault(addon_id, {}).setdefault("updates", [])
    entries = [e for e in entries if e.get("version") != version]
    entries.append({
        "version": version,
        "update_link": link,
        "update_hash": "sha256:" + digest,
    })
    entries.sort(key=lambda e: version_key(e["version"]))
    updates["addons"][addon_id]["updates"] = entries
    with open(UPDATES, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(updates, indent=2) + "\n")

    print("Add-on   : %s %s" % (local["name"], version))
    print("signiert : %s" % ("ja" if is_signed else "NEIN"))
    print("Paket    : %s (%d Bytes)" % (target, os.path.getsize(target)))
    print("sha256   : %s" % digest)
    print("Link     : %s" % link)
    print("updates.json aktualisiert, %d Eintrag/Eintraege" % len(entries))
    print()

    if not args.publish:
        print("Probelauf - nichts veroeffentlicht. Mit --publish wuerde folgen:")
        print("  $ gh release create %s %s --title %s --notes ..." % (tag, target, tag))
        print("  $ git add updates.json && git commit && git push")
        return

    exists = subprocess.run(["gh", "release", "view", tag],
                            cwd=HERE, capture_output=True).returncode == 0
    print("Release anlegen:")
    if exists:
        run(["gh", "release", "upload", tag, target, "--clobber"])
    else:
        run(["gh", "release", "create", tag, target,
             "--title", "%s %s" % (local["name"], version),
             "--notes", "Von Mozilla signierte Fassung.\n\nsha256: %s" % digest])

    print("updates.json veroeffentlichen:")
    run(["git", "add", "updates.json"])
    run(["git", "commit", "-m", "updates.json: %s" % version])
    run(["git", "push"])
    print()
    print("Fertig. Firefox prueft die update_url etwa einmal pro Tag;")
    print("sofort geht es ueber about:addons -> Zahnrad -> Nach Updates suchen.")


if __name__ == "__main__":
    main()
