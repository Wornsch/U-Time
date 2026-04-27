# U-Time

U-Time ist eine moderne Web-App fuer Live-Abfahrten der Wiener Linien. Die App zeigt Stationen und Linien auf einer Karte, filtert nach Verkehrsmittel und liefert aktuelle Wartezeiten direkt aus den Open-Data-Schnittstellen der Wiener Linien.

## Features

- Interaktive Wien-Karte mit Liniennetz und Stationspunkten
- Live-Abfahrten fuer U-Bahn, Bim und Bus
- Filter pro Verkehrsmittel, inklusive passender Abfahrtsanzeige
- Gruppierte Richtungen, z. B. `Oberlaa / Alaudagasse` bei der U1
- Pro Richtung nur die aktuelle und die naechste Wartezeit
- Stationssuche nach Name oder Linie
- Standortsuche fuer die naechste passende Station
- Favoriten mit eigener Live-Abfahrtsansicht
- Lokaler Proxy fuer Wiener-Linien-Daten ohne Browser-CORS-Probleme
- Responsive Layout fuer Desktop und Mobile
- Native iOS-Huelle via Capacitor fuer private Installation auf dem iPhone

## Tech Stack

- React
- TypeScript
- Vite
- Leaflet / React Leaflet
- PapaParse
- Express
- Capacitor
- Wiener Linien Open Data

## Lokales Setup

```bash
npm install
npm run dev
```

Danach laeuft die App im Development-Modus typischerweise unter:

```text
http://localhost:5173
```

## Production Build

```bash
npm run build
npm run preview
```

Der Preview-Server nutzt `server.mjs` und liefert die gebaute App inklusive API-Proxy aus.

Standard-Port:

```text
http://localhost:4173
```

Optional kann ein anderer Port gesetzt werden:

```bash
PORT=8080 npm run preview
```

Unter Windows PowerShell:

```powershell
$env:PORT=8080; npm run preview
```

## Scripts

```bash
npm run dev      # Startet Vite mit Wiener-Linien-Proxy
npm run build    # TypeScript-Check und Production-Build
npm run ios:sync # Baut die Web-App und synchronisiert sie ins iOS-Projekt
npm run ios:open # Oeffnet das iOS-Projekt in Xcode
npm run preview  # Startet den Express-Preview-Server
npm run lint     # ESLint-Check
```

## Private iOS-App

U-Time kann als native iOS-App mit Capacitor gebaut werden. Fuer die private, kostenlose Installation auf dem eigenen iPhone brauchst du einen Mac mit Xcode und eine normale Apple ID.

Kurzfassung auf dem Mac:

```bash
npm install
npm run ios:sync
npm run ios:open
```

Danach in Xcode `Signing & Capabilities` auf deine Personal Team stellen, iPhone verbinden und Play druecken.

Ausfuehrliche Anleitung:

[Private iOS-Installation](docs/ios-private-install.md)

## Datenquelle

U-Time verwendet die offiziellen Open-Data-Daten der Wiener Linien:

- Haltepunkte und Stationen
- Linieninformationen
- Fahrwegverlaeufe
- Echtzeitdaten ueber den `monitor`-Endpoint

Weitere Informationen:

[Wiener Linien Open Data](https://www.wienerlinien.at/open-data)

## Warum ein Proxy?

Die Wiener-Linien-Open-Data-Endpoints liefern keine vollstaendigen CORS-Header fuer direkten Browserzugriff. Deshalb nutzt U-Time lokal `/api/wl/...` als Proxy.

Im Development-Modus uebernimmt Vite den Proxy. Im Production-Preview uebernimmt `server.mjs` denselben Pfad.

In der nativen iOS-App nutzt U-Time Capacitor HTTP und ruft die Wiener-Linien-Endpunkte direkt auf, weil dort kein lokaler Express-Proxy laeuft.

## Projektstruktur

```text
.
├── server.mjs          # Express-Server und API-Proxy
├── vite.config.ts      # Vite-Konfiguration mit Dev-Proxy
├── src/
│   ├── App.tsx         # Haupt-UI, Karte, Suche, Favoriten, Abfahrten
│   ├── App.css         # Styling und responsive Layout
│   ├── api.ts          # Open-Data-Loader und Echtzeit-Fetching
│   ├── types.ts        # TypeScript-Typen
│   ├── utils.ts        # Formatierung, Farben, Distanzen
│   └── main.tsx        # React-Einstiegspunkt
└── package.json
```

## Hinweise

- Fuer die Standortfunktion muss der Browser Geolocation erlauben.
- Die App benoetigt keinen API-Key.
- Live-Daten haengen von der Verfuegbarkeit der Wiener-Linien-Open-Data-Services ab.
