# U-Time privat auf dem iPhone installieren

Diese Variante ist fuer die private Nutzung gedacht: kein App Store, kein TestFlight, keine bezahlte Apple Developer Program Mitgliedschaft. Du installierst die App direkt mit Xcode auf dein eigenes iPhone.

## Was du brauchst

- Einen Mac mit aktuellem Xcode
- Dein iPhone und ein USB-Kabel
- Eine normale Apple ID
- Node.js und npm auf dem Mac

Wichtig: Eine echte iOS-App kostenlos geht nur mit Mac und Xcode. Ohne Mac ist die unkomplizierte kostenlose Alternative die Web-App ueber Safari zum Home-Bildschirm hinzuzufuegen.

## Projekt auf dem Mac vorbereiten

```bash
git clone https://github.com/Wornsch/U-Time.git
cd U-Time
npm install
npm run ios:sync
npm run ios:open
```

Wenn du das Projekt schon hast:

```bash
git pull
npm install
npm run ios:sync
npm run ios:open
```

`ios:sync` baut die Web-App und kopiert sie in das native iOS-Projekt.

## In Xcode aufs iPhone installieren

1. In Xcode: `Settings` bzw. `Preferences` > `Accounts` > Apple ID hinzufuegen.
2. Links im Projekt `App` auswaehlen, dann Target `App`.
3. Unter `Signing & Capabilities` aktivieren:
   - `Automatically manage signing`
   - `Team`: deine Personal Team / Apple ID
4. Falls Xcode wegen der Bundle ID meckert, aendere `Bundle Identifier` z. B. auf:

```text
at.deinname.utime
```

5. iPhone per Kabel verbinden, entsperren und dem Mac vertrauen.
6. Oben in Xcode dein iPhone als Run-Ziel auswaehlen.
7. Play-Button druecken.

Beim ersten Start kann iOS fragen, ob du dem Entwickler vertraust oder Developer Mode aktivieren moechtest. Folge dann den iPhone-Hinweisen in den Einstellungen.

## Spaetere Updates installieren

Nach Code-Aenderungen:

```bash
git pull
npm install
npm run ios:sync
npm run ios:open
```

Dann in Xcode wieder Play druecken.

## Kostenlose Grenzen

- Kostenlos mit Apple ID reicht fuer dein eigenes iPhone und private Nutzung.
- App Store, TestFlight und dauerhafte Verteilung an andere Personen brauchen eine bezahlte Apple Developer Program Mitgliedschaft.
- Falls die kostenlos signierte App nach einiger Zeit nicht mehr startet, einfach auf dem Mac erneut aus Xcode installieren.
