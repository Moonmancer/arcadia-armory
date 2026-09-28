"""Generates src/theme-armory.css: a grayscale version of the calculator's dark
theme (plus the add-on's own panel styles), scoped to html.aa-theme-armory.

Every rule of the source stylesheets that sets a color keeps its selector, gets
the color converted to its gray value and is marked !important; decorative
background images are removed. Run again when the calculator's CSS changes:

    python tools/make_armory_theme.py
"""

import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "theme-armory.css"
SCOPE = "html.aa-theme-armory"
CALC = "https://calc.arcadia-online.org/"

# Calculator sheets in cascade order, then the add-on's panel (converted too so it matches).
SOURCES = [
    ("calc style.css", lambda: fetch(CALC + "style.css")),
    ("calc style-dark.css", lambda: fetch(CALC + "style-dark.css")),
    ("add-on panel.css", lambda: (ROOT / "src" / "panel.css").read_text(encoding="utf-8")),
]

# Element / race classes used in the calculator's generated HTML (v_Element, v_Race).
ACCENTS = {
    "eleNeutral": "#c2b29a", "eleWater": "#5b9bff", "eleEarth": "#c98a4f", "eleFire": "#ff5a4f",
    "eleWind": "#44d46e", "elePoison": "#d466d4", "eleHoly": "#e8da50", "eleShadow": "#9a78f0",
    "eleGhost": "#dcdbd8", "eleUndead": "#b877dc",
    "RaceFormless": "#a8a8a8", "RaceUndead": "#b877dc", "RaceBrute": "#c98a4f", "RacePlant": "#4fe04f",
    "RaceInsect": "#5cbf5c", "RaceFish": "#5b9bff", "RaceDemon": "#a69bc2", "RaceDemihuman": "#ffa640",
    "RaceAngel": "#e3e35f", "RaceDragon": "#ff5a4f",
}

# Rules whose colors carry meaning and stay as they are.
KEEP_SELECTORS = re.compile(r"aa-up|aa-down|aa-bbest|\.ele[A-Z]|\.Race[A-Z]")
# Background images that are icons rather than decoration.
KEEP_IMAGES = re.compile(r"closebtn", re.I)

NAMED = {
    "white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0), "green": (0, 128, 0),
    "blue": (0, 0, 255), "yellow": (255, 255, 0), "purple": (128, 0, 128), "orange": (255, 165, 0),
    "gray": (128, 128, 128), "grey": (128, 128, 128), "silver": (192, 192, 192), "brown": (165, 42, 42),
    "navy": (0, 0, 128), "teal": (0, 128, 128), "maroon": (128, 0, 0), "olive": (128, 128, 0),
    "lime": (0, 255, 0), "aqua": (0, 255, 255), "fuchsia": (255, 0, 255), "gold": (255, 215, 0),
    "darkblue": (0, 0, 139), "darkred": (139, 0, 0), "darkgreen": (0, 100, 0), "pink": (255, 192, 203),
}
COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(" + "|".join(NAMED) + r")\b", re.I)
COLOR_PROPS = re.compile(r"^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color)$")


def fetch(url):
    # The server rejects urllib's default user agent.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ArcadiaArmory theme build)"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8", "replace")


def gray(r, g, b):
    return round(0.2126 * r + 0.7152 * g + 0.0722 * b)


def to_gray(m):
    c = m.group(0)
    low = c.lower()
    alpha = None
    if low.startswith("#"):
        h = low[1:]
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        if len(h) == 8:
            alpha = int(h[6:8], 16) / 255
    elif low.startswith("rgb"):
        nums = [float(x) for x in re.findall(r"[\d.]+", low)]
        r, g, b = nums[:3]
        alpha = nums[3] if len(nums) > 3 else None
    else:
        r, g, b = NAMED[low]
    v = gray(r, g, b)
    if alpha is not None:
        return f"rgba({v}, {v}, {v}, {round(alpha, 3)})"
    return f"#{v:02x}{v:02x}{v:02x}"


def convert_decls(body):
    out = []
    for decl in body.split(";"):
        if ":" not in decl:
            continue
        prop, value = decl.split(":", 1)
        prop, value = prop.strip().lower(), value.strip().replace("!important", "").strip()
        if not COLOR_PROPS.match(prop):
            continue
        if "url(" in value:
            if KEEP_IMAGES.search(value):
                continue
            out.append("background-image: none !important")
            rest = re.sub(r"url\([^)]*\)", "", value)
            colors = [m.group(0) for m in COLOR_RE.finditer(rest)]
            if colors:
                out.append(f"background-color: {COLOR_RE.sub(to_gray, colors[0])} !important")
            continue
        if COLOR_RE.search(value) or value in ("transparent", "none"):
            out.append(f"{prop}: {COLOR_RE.sub(to_gray, value)} !important")
    return out


def scope(selectors):
    out = []
    for sel in selectors.split(","):
        sel = sel.strip()
        if not sel:
            continue
        if re.match(r"^html\b", sel):
            out.append(SCOPE + sel[4:])
        elif re.match(r"^:root\b", sel):
            out.append(SCOPE + sel[5:])
        else:
            out.append(f"{SCOPE} {sel}")
    return ",\n".join(out)


def convert(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out, i = [], 0
    # Minimal parser: top-level rules and one level of @media nesting.
    for m in re.finditer(r"(@media[^{]*)\{((?:[^{}]*\{[^{}]*\})*)\s*\}|([^{}@]+)\{([^{}]*)\}", css):
        if m.group(1):
            inner = convert(m.group(2))
            if inner.strip():
                out.append(f"{m.group(1).strip()} {{\n{inner}\n}}")
        else:
            sel, body = m.group(3).strip(), m.group(4)
            if KEEP_SELECTORS.search(sel):
                continue
            decls = convert_decls(body)
            if decls:
                out.append(scope(sel) + " {\n\t" + ";\n\t".join(decls) + ";\n}")
    return "\n".join(out)


def main():
    parts = [
        "/* Generated by tools/make_armory_theme.py - do not edit by hand. */",
        "/* Grayscale dark theme \"Armory\", active while <html> has class aa-theme-armory. */",
        "",
        f"{SCOPE}, {SCOPE} body {{ background-color: #141414 !important; color-scheme: dark; }}",
        f"{SCOPE} img {{ filter: grayscale(1); }}",
        "",
        "/* Element and race names keep a color (they carry meaning, e.g. in the combat",
        "   simulator). The calculator's inline colors are meant for a light background",
        "   and are overridden by its dark theme anyway, so use readable ones here. */",
    ]
    for cls, color in ACCENTS.items():
        # :not(#aa-none) adds ID weight to beat calculator rules like "#B_3 b".
        parts.append(f"{SCOPE} .{cls}:not(#aa-none) {{ color: {color} !important; }}")
    parts.append("")
    for name, load in SOURCES:
        parts += ["", f"/* ---- {name} ---- */", convert(load())]
    # Some bars give their fields a colored background with differently colored
    # text (e.g. gold on purple in ".subheader select"); in gray both end up
    # alike. Give every form field one readable dark style instead. :not(#aa-none)
    # adds ID weight so this beats those bar rules.
    fields = [
        "select", "textarea", 'input:not([type])', 'input[type="text"]', 'input[type="number"]', 'input[type="search"]',
    ]
    sel = ",\n".join(f"{SCOPE} {f}:not(.aa-cinput):not(#aa-none)" for f in fields)
    parts += [
        "",
        "/* ---- readable form fields ---- */",
        sel + " {\n\tbackground-color: #262626 !important;\n\tcolor: #e6e6e6 !important;\n\tborder-color: #5a5a5a !important;\n}",
        f"{SCOPE} option:not(#aa-none) {{\n\tbackground-color: #262626 !important;\n\tcolor: #e6e6e6 !important;\n}}",
    ]
    OUT.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
