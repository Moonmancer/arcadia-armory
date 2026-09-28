# Veroeffentlicht eine von Mozilla signierte .xpi als GitHub-Release und
# traegt sie in updates.json ein, damit Firefox das Update automatisch findet.
#
#   python release.py                 Probelauf
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
# Reihenfolge im Gesamtablauf:
#   1. python package.py                      Paket bauen (dist/<version>/...-unsigned.xpi)
#   2. bei addons.mozilla.org hochladen       signieren lassen
#   3. signierte .xpi herunterladen
#   4. python release.py --publish            veroeffentlichen
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
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
    ap.add_argument("--publish", action="store_true",
                    help="Release wirklich anlegen und updates.json pushen")
    ap.add_argument("--allow-unsigned", action="store_true",
                    help="Sicherheitsabfrage auf die Signatur uebergehen")
    args = ap.parse_args()
    os.chdir(HERE)

    with open("manifest.json", encoding="utf-8") as fh:
        local = json.load(fh)
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
