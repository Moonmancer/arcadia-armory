# Arcadia Armory

Firefox-Addon für den [Arcadia Online Character Calculator](https://calc.arcadia-online.org).

1. **Import** – im Control Panel unter *My Master Account Item List*
   (`cp.arcadia-online.org/masteraccount/items/`) auf **⚔ Ausrüstung an Arcadia Armory senden**
   klicken; beim nächsten Öffnen des Calculators erscheint „Neue Liste vom Control Panel“ mit
   *Ersetzen* / *Hinzufügen* / *Verwerfen*. Alternativ eine Item-Liste ins Import-Feld einfügen.
   Waffen und Ausrüstung werden erkannt und mit Verfeinerung, Karten, Schmiede-Element/Star Crumbs
   und Lagerort gespeichert, alles andere (Tränke, lose Karten, Kostüme, Beute …) wird übersprungen.
2. **Eigene Items im Calculator** – eigene Items sind in den Auswahllisten mit ★ markiert; optional
   werden nur noch eigene Items angezeigt. Beim Auswählen eines eigenen Items werden dessen
   Verfeinerung und Karten automatisch übernommen (bei mehreren Exemplaren das stärkste).
3. **Schadensvorschau** – beim Öffnen einer Ausrüstungsauswahl steht hinter jedem Eintrag, wie sich
   der Schaden ändern würde (`▲ +12.3%`). Der Tab *Vergleich* zeigt alle eigenen Exemplare pro Slot
   sortiert nach Schadensgewinn, mit „Anlegen“-Knopf. **Beste DPS anlegen** / **Bester Einzelschaden anlegen**
   legen automatisch die stärkste Kombination deiner Exemplare an (mit Rückgängig).
4. **Suchfeld statt Auswahlliste** – die Ausrüstungs-Slots sind Textfelder mit Live-Suche (mehrere
   Begriffe, auch nach Karten, Element oder Lagerort). Die Trefferliste zeigt eigene Exemplare
   einzeln mit Refine/Karten, die Schadensänderung farbig und lässt sich nach Name oder Schaden
   sortieren; Pfeiltasten/Enter/Esc funktionieren. Die Kartenfelder und die Card Shortcuts
   sind ebenfalls Suchfelder (Listen des Calculators, mit Schadensvorschau).
   Zusätzlich gibt es in den Card Shortcuts die Ausrüstungs-Sets Goibne's, Morrigane's, Valkyrian, Morpheus's, die Odin's-Blessing-Sets und
   die Diabolus-Sets:
   sie legen alle Set-Teile in ihren Slots an (eigene Exemplare mit Refine/Karten bevorzugt). Abschaltbar unter *Meine Items*.
5. **Stat-Vorschlag** – neben jedem Stat steht, was +1 im gewählten Maßstab bringt und wie viele
   Statuspunkte es kostet; ★ markiert das beste Verhältnis unter den bezahlbaren. Klick setzt +1.
5. **Monster- und Klassen-Suche** – Monster- und Klassenauswahl sind Suchfelder; bei Monstern zeigt jede Zeile Level, Rasse, Element,
   Größe und HP (alles durchsuchbar, z. B. „fire demi“).
6. **Theme „Armory“** – zusätzliche Option in der Theme-Auswahl des Calculators: schlichtes
   Graustufen-Dark-Design, mit dem Addon standardmäßig aktiv. Neu erzeugen, wenn sich die Stylesheets
   des Calculators ändern: `python tools/make_armory_theme.py`.
7. **Pre-trans WoE-Filter** – Schalter unter *Meine Items*: blendet die in Pre-trans WoE verbotenen
   Items und Karten überall aus (Auswahl, Suchfelder, Vergleich). Eigene Exemplare werden über die
   Item-ID geprüft und in *Meine Items* als „WoE-verboten“ markiert. Liste aktualisieren:
   `python tools/update_woe_blacklist.py`.
8. **Hände tauschen (Assassin)** – im Dual-Wield-Modus tauscht der Button **⇄** neben „Left Hand:“
   die Waffen der rechten und linken Hand samt Verfeinerung und Karten.

Gerechnet wird mit der Engine des Calculators selbst, also mit aktuellem Charakter, Skill und
Monster. Maßstab: Ø Schaden pro Sekunde oder pro Treffer (einstellbar).

## Installation

Die signierte Fassung liegt unter den
[GitHub-Releases](https://github.com/Moonmancer/arcadia-armory/releases): `.xpi` herunterladen und in
`about:addons` über das Zahnrad **Add-on aus Datei installieren** wählen. Updates holt Firefox danach
selbst (etwa einmal täglich, sofort über Zahnrad → **Nach Updates suchen**).

### Entwicklung

1. Firefox öffnen: `about:debugging#/runtime/this-firefox`
2. **Temporäres Add-on laden…** → `manifest.json` in diesem Ordner auswählen
3. Calculator öffnen, unten rechts auf **⚔ Armory** klicken

## Veröffentlichen

Unsignierte Addons lässt Firefox Release nicht dauerhaft zu. Das Addon wird deshalb als **unlisted**
signiert – es bleibt privat, die Prüfung ist automatisiert und dauert meist nur Minuten.

1. `version` in `manifest.json` erhöhen (jede Versionsnummer lässt sich nur einmal einreichen).
2. Paket bauen und prüfen – die Zusammenfassung muss `errors 0` zeigen:

   ```bash
   python package.py
   npx web-ext lint --source-dir build --self-hosted
   ```

3. Auf [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) anmelden, **Submit a New
   Add-on** (bzw. bei Updates **Upload New Version**), als Kanal **On your own** wählen.
4. `arcadia-armory.xpi` hochladen. Die Frage nach dem Quellcode mit **nein** beantworten – nichts ist
   minifiziert oder gebündelt (`woe-blacklist.js` und `theme-armory.css` sind lesbar generiert).
5. Die signierte `.xpi` unter **Manage My Submissions → Versions** herunterladen.
6. Signierte Fassung veröffentlichen, damit Firefox das Update findet (erster Aufruf = Probelauf):

   ```bash
   python release.py ~/Downloads/arcadia_armory-1.0.0.xpi
   python release.py ~/Downloads/arcadia_armory-1.0.0.xpi --publish
   ```

   `release.py` prüft Signatur, Id und Version, legt das GitHub-Release an, trägt Link und sha256 in
   `updates.json` ein und pusht sie. `manifest.json` → `update_url` → `updates.json` → Release-Asset.

| Manifest | Wert | Warum |
| --- | --- | --- |
| `id` | `arcadia-armory@moonmancer.local` | dauerhaft ab der ersten Signatur |
| `update_url` | `raw.githubusercontent.com/.../updates.json` | ohne sie sucht Firefox nie nach Updates; das Repo muss öffentlich sein |
| `data_collection_permissions` | `["none"]` | Pflicht für neue Addons; das Addon sendet nichts nach außen |
| `strict_min_version` | `142.0` | ab dieser Version kennt auch Firefox for Android `data_collection_permissions` |

## Aufbau

- `src/page.js` – läuft im Seitenkontext (braucht `m_Item`, `calc()` usw.): Parser, Filter,
  Simulation, Panel
- `src/bridge.js` – läuft isoliert, speichert in `browser.storage.local`
- `src/cp.js` – Button auf der Item-Liste im Control Panel, übergibt die Tabelle an den Calculator
- `src/panel.css` – Styles des Panels
- `src/theme-armory.css`, `src/woe-blacklist.js` – generiert von `tools/make_armory_theme.py` bzw.
  `tools/update_woe_blacklist.py`
- `src/headgear-slots.js` – Headgears, die mehrere Kopf-Slots belegen (z. B. Mythical Lion Mask = Upper +
  Middle), aus der Item-Datenbank des Control Panels: `python tools/update_headgear_slots.py`
- `package.py`, `release.py` – Paket bauen bzw. signierte Fassung veröffentlichen

## Grenzen

- Items werden über den Namen zugeordnet (der Calculator hat eigene IDs). Wo der Name mehrdeutig
  ist, entscheidet die Slot-Anzahl bzw. die Item-ID (`GAME_ID_OVERRIDES` in `src/page.js`, z. B.
  Survivor's Rod DEX/INT). Nicht erkannte Einträge stehen im Import-Tab.
- Die Vorschau ändert nur das Item (plus Refine/Karten eigener Items). Andere Abhängigkeiten, z. B.
  Munition beim Wechsel auf einen Bogen oder ein Skill, der mit der neuen Waffe nicht geht,
  werden nicht angepasst.
