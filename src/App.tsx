import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  Clock3,
  LocateFixed,
  MapPinned,
  RefreshCw,
  Search,
  Star,
  X,
} from "lucide-react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { PathOptions } from "leaflet";
import { fetchDepartures, loadNetworkData } from "./api";
import type {
  Departure,
  DepartureFeed,
  NetworkData,
  Station,
  TransportFilter,
  TransportMode,
  UserLocation,
} from "./types";
import {
  distanceInMeters,
  formatDepartureTime,
  formatDistance,
  lineColor,
  modeLabel,
  normalizeSearch,
  stationMatchesFilter,
  WIEN_CENTER,
} from "./utils";

const FAVORITES_KEY = "u-time:favorites";
const transportFilters: TransportFilter[] = ["ptMetro", "ptTram", "ptBus", "all"];
const MAX_DEPARTURE_GROUPS = 8;
const MAX_FAVORITE_FEEDS = 8;

interface DepartureGroup {
  id: string;
  line: string;
  towards: string;
  platform: string | null;
  type: TransportMode;
  realtimeSupported: boolean;
  stationTitle: string;
  departures: Departure[];
}

type FavoritesTab = "stations" | "departures";

function loadFavoriteIds(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveFavoriteIds(ids: string[]): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
}

function MapFocus({ station, userLocation }: { station: Station | null; userLocation: UserLocation | null }) {
  const map = useMap();
  useEffect(() => {
    if (station) {
      map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 15), { duration: 0.7 });
      return;
    }
    if (userLocation) {
      map.flyTo([userLocation.lat, userLocation.lon], Math.max(map.getZoom(), 14), { duration: 0.7 });
    }
  }, [map, station, userLocation]);
  return null;
}

function ZoomState({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  useMapEvents({ zoomend(event) { onZoomChange(event.target.getZoom()); } });
  return null;
}

function LineBadge({ line, mode }: { line: string; mode?: TransportMode }) {
  const color = lineColor({ name: line, mode: mode ?? (line.startsWith("U") ? "ptMetro" : "unknown") });
  const textColor = readableTextColor(color);
  return (
    <span className="line-badge" style={{ "--line-color": color, "--line-text-color": textColor } as CSSProperties}>
      {line}
    </span>
  );
}

function readableTextColor(hexColor: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor);
  if (!match) return "#ffffff";
  const [, r, g, b] = match;
  const lum = (0.2126 * parseInt(r, 16) + 0.7152 * parseInt(g, 16) + 0.0722 * parseInt(b, 16)) / 255;
  return lum > 0.48 ? "#101820" : "#ffffff";
}

function departureMatchesFilter(departure: Departure, filter: TransportFilter): boolean {
  return filter === "all" || departure.type === filter;
}

function departureWaitLabel(departure: Departure): string {
  const countdown = departure.countdown;
  if (countdown === null) return formatDepartureTime(departure.timeReal ?? departure.timePlanned);
  return countdown <= 0 ? "jetzt" : `${countdown} min`;
}

function directionKey(d: Departure): string {
  return [d.type, d.line, d.directionId || d.direction || d.platform || d.towards, d.platform ?? ""].join("-");
}

const terminalNamesByLine = new Map<string, Set<string>>([
  ["U1", new Set(["Leopoldau", "Oberlaa"])],
  ["U2", new Set(["Schottentor", "Seestadt"])],
  ["U3", new Set(["Ottakring", "Simmering"])],
  ["U4", new Set(["Hütteldorf", "Heiligenstadt"])],
  ["U6", new Set(["Floridsdorf", "Siebenhirten"])],
]);

function directionLabel(line: string, towardsCounts: Map<string, number>): string {
  const terminals = terminalNamesByLine.get(line) ?? new Set<string>();
  const labels = Array.from(towardsCounts.entries())
    .sort((a, b) => {
      const t = Number(terminals.has(b[0])) - Number(terminals.has(a[0]));
      return t || b[1] - a[1] || a[0].localeCompare(b[0], "de");
    })
    .map(([l]) => l);
  if (labels.length === 0) return "Unbekanntes Ziel";
  return labels.slice(0, 2).join(" / ");
}

function createDepartureGroups(source: Departure[], filter: TransportFilter, max = MAX_DEPARTURE_GROUPS): DepartureGroup[] {
  const groups = new Map<string, Omit<DepartureGroup, "towards" | "departures"> & { departures: Departure[]; towardsCounts: Map<string, number> }>();
  const sorted = source.filter((d) => departureMatchesFilter(d, filter)).sort((a, b) => (a.countdown ?? 999) - (b.countdown ?? 999));
  for (const d of sorted) {
    const id = directionKey(d);
    const ex = groups.get(id);
    if (ex) {
      ex.departures.push(d);
      ex.towardsCounts.set(d.towards, (ex.towardsCounts.get(d.towards) ?? 0) + 1);
      continue;
    }
    groups.set(id, {
      id, line: d.line, platform: d.platform, type: d.type, realtimeSupported: d.realtimeSupported,
      stationTitle: d.stationTitle, departures: [d], towardsCounts: new Map([[d.towards, 1]]),
    });
  }
  return Array.from(groups.values()).map((g) => ({
    id: g.id, line: g.line, towards: directionLabel(g.line, g.towardsCounts),
    platform: g.platform, type: g.type, realtimeSupported: g.realtimeSupported,
    stationTitle: g.stationTitle, departures: g.departures.slice(0, 2),
  })).sort((a, b) => (a.departures[0]?.countdown ?? 999) - (b.departures[0]?.countdown ?? 999)).slice(0, max);
}

function TimelineRow({ group }: { group: DepartureGroup }) {
  const main = group.departures[0];
  const soon = (main?.countdown ?? 99) <= 1;
  return (
    <article className={`timeline-row ${soon ? "soon" : ""}`}>
      <div className="timeline-time">
        <strong>{main && main.countdown !== null && main.countdown <= 0 ? "jetzt" : main?.countdown ?? "—"}</strong>
        <small>{soon ? "AKTUELL" : "MIN"}</small>
      </div>
      <div className="timeline-dot" aria-hidden />
      <div className="timeline-body">
        <div className="timeline-meta">
          <LineBadge line={group.line} mode={group.type} />
          <strong>{group.towards}</strong>
        </div>
        <span className="timeline-sub">
          {group.platform ? `Steig ${group.platform} · ` : ""}{group.realtimeSupported ? "Echtzeit" : "Plan"}
        </span>
      </div>
    </article>
  );
}

function StationButton({ station, selected, detail, lineModesByName, filter, onSelect }: {
  station: Station; selected?: boolean; detail?: string;
  lineModesByName?: Map<string, TransportMode>; filter?: TransportFilter;
  onSelect: (station: Station) => void;
}) {
  const matchingLines = station.lines.filter((line) => {
    const mode = lineModesByName?.get(line);
    return !filter || filter === "all" || mode === filter;
  });
  const visibleLines = matchingLines.length ? matchingLines : station.lines;
  return (
    <button className={`station-button ${selected ? "selected" : ""}`} type="button" onClick={() => onSelect(station)}>
      <span>
        <strong>{station.name}</strong>
        <span>{detail ?? station.municipality}</span>
      </span>
      <div className="station-meta">
        {visibleLines.slice(0, 5).map((line) => (
          <LineBadge key={line} line={line} mode={lineModesByName?.get(line) ?? station.modes[0]} />
        ))}
        {visibleLines.length > 5 ? <span className="more-lines">+{visibleLines.length - 5}</span> : null}
      </div>
    </button>
  );
}

function FavoriteDepartureCard({ station, feed, filter, lineModesByName, onSelect }: {
  station: Station; feed: DepartureFeed | undefined; filter: TransportFilter;
  lineModesByName: Map<string, TransportMode>; onSelect: (station: Station) => void;
}) {
  const groups = feed ? createDepartureGroups(feed.departures, filter, 2) : [];
  return (
    <button className="favorite-departure-card" type="button" onClick={() => onSelect(station)}>
      <span className="favorite-card-title">
        <strong>{station.name}</strong>
        <span>
          {station.lines.filter((l) => filter === "all" || lineModesByName.get(l) === filter).slice(0, 5).join(" · ") || modeLabel(filter)}
        </span>
      </span>
      {groups.length ? (
        <span className="favorite-times">
          {groups.map((g) => (
            <span className="favorite-time-row" key={g.id}>
              <LineBadge line={g.line} mode={g.type} />
              <strong>{departureWaitLabel(g.departures[0])}</strong>
              {g.departures[1] ? <small>{departureWaitLabel(g.departures[1])}</small> : null}
            </span>
          ))}
        </span>
      ) : (
        <span className="favorite-empty">{feed ? "Keine passenden Abfahrten" : "Lädt..."}</span>
      )}
    </button>
  );
}

function App() {
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [departures, setDepartures] = useState<DepartureFeed | null>(null);
  const [departureError, setDepartureError] = useState<string | null>(null);
  const [isLoadingDepartures, setIsLoadingDepartures] = useState(false);
  const [transportFilter, setTransportFilter] = useState<TransportFilter>("ptMetro");
  const [searchQuery, setSearchQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => loadFavoriteIds());
  const [favoritesTab, setFavoritesTab] = useState<FavoritesTab>("stations");
  const [favoriteFeeds, setFavoriteFeeds] = useState<Record<string, DepartureFeed>>({});
  const [favoriteFeedError, setFavoriteFeedError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [geoStatus, setGeoStatus] = useState<"idle" | "loading" | "error">("idle");
  const [mapZoom, setMapZoom] = useState(12);

  useEffect(() => {
    let active = true;
    loadNetworkData().then((data) => {
      if (!active) return;
      setNetwork(data);
      const start = data.stations.find((s) => s.name === "Stephansplatz") ??
        data.stations.find((s) => s.name === "Karlsplatz") ??
        data.stations.find((s) => s.lines.includes("U1"));
      setSelectedStationId(start?.id ?? data.stations[0]?.id ?? null);
    }).catch((e) => { if (active) setNetworkError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  const selectedStation = useMemo(() => {
    if (!network || !selectedStationId) return null;
    return network.stations.find((s) => s.id === selectedStationId) ?? null;
  }, [network, selectedStationId]);

  const lineModesByName = useMemo(() => {
    const m = new Map<string, TransportMode>();
    for (const l of network?.linesById.values() ?? []) m.set(l.name, l.mode);
    return m;
  }, [network]);

  const favoriteStations = useMemo(() => {
    if (!network) return [];
    const set = new Set(favoriteIds);
    return network.stations.filter((s) => set.has(s.id));
  }, [favoriteIds, network]);

  useEffect(() => {
    let active = true;
    const stations = favoriteStations.slice(0, MAX_FAVORITE_FEEDS);
    if (!stations.length) { setFavoriteFeeds({}); setFavoriteFeedError(null); return; }

    async function refresh() {
      try {
        const results = await Promise.allSettled(stations.map(async (s) => ({ stationId: s.id, feed: await fetchDepartures(s.rbls) })));
        if (!active) return;
        const next: Record<string, DepartureFeed> = {};
        let failed = false;
        for (const r of results) {
          if (r.status === "fulfilled") next[r.value.stationId] = r.value.feed;
          else failed = true;
        }
        setFavoriteFeeds(next);
        setFavoriteFeedError(failed ? "Einige Favoriten konnten nicht aktualisiert werden." : null);
      } catch (e) { if (active) setFavoriteFeedError(e instanceof Error ? e.message : String(e)); }
    }
    void refresh();
    const id = window.setInterval(refresh, 45_000);
    return () => { active = false; window.clearInterval(id); };
  }, [favoriteStations]);

  const searchResults = useMemo(() => {
    if (!network) return [];
    const q = normalizeSearch(searchQuery);
    if (!q) return [];
    return network.stations.filter((s) => {
      if (!stationMatchesFilter(s, transportFilter)) return false;
      return normalizeSearch(`${s.name} ${s.lines.join(" ")}`).includes(q);
    }).slice(0, 10);
  }, [network, searchQuery, transportFilter]);

  const nearbyStations = useMemo(() => {
    if (!network || !userLocation) return [];
    return network.stations.filter((s) => stationMatchesFilter(s, transportFilter))
      .map((s) => ({ station: s, distance: distanceInMeters(s, userLocation) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 4);
  }, [network, transportFilter, userLocation]);

  const refreshDepartures = useCallback(async (station: Station | null = selectedStation) => {
    if (!station) return;
    setIsLoadingDepartures(true); setDepartureError(null);
    try { setDepartures(await fetchDepartures(station.rbls)); }
    catch (e) { setDepartureError(e instanceof Error ? e.message : String(e)); }
    finally { setIsLoadingDepartures(false); }
  }, [selectedStation]);

  useEffect(() => {
    if (!selectedStation) return;
    void refreshDepartures(selectedStation);
    const id = window.setInterval(() => void refreshDepartures(selectedStation), 30_000);
    return () => window.clearInterval(id);
  }, [refreshDepartures, selectedStation]);

  const selectStation = useCallback((s: Station) => {
    setSelectedStationId(s.id); setSearchQuery("");
  }, []);

  const toggleFavorite = useCallback(() => {
    if (!selectedStation) return;
    setFavoriteIds((curr) => {
      const next = curr.includes(selectedStation.id) ? curr.filter((id) => id !== selectedStation.id) : [selectedStation.id, ...curr];
      saveFavoriteIds(next); return next;
    });
  }, [selectedStation]);

  const locateNearestStation = useCallback(() => {
    if (!navigator.geolocation || !network) { setGeoStatus("error"); return; }
    setGeoStatus("loading");
    navigator.geolocation.getCurrentPosition((p) => {
      const loc: UserLocation = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
      setUserLocation(loc); setGeoStatus("idle");
      const nearest = network.stations.filter((s) => stationMatchesFilter(s, transportFilter))
        .map((s) => ({ station: s, distance: distanceInMeters(s, loc) }))
        .sort((a, b) => a.distance - b.distance)[0]?.station;
      if (nearest) selectStation(nearest);
    }, () => setGeoStatus("error"), { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
  }, [network, selectStation, transportFilter]);

  const visibleRoutes = useMemo(() => {
    if (!network) return [];
    const sel = selectedStation
      ? network.routes.filter((r) => r.stationIds.includes(selectedStation.id) && (transportFilter === "all" || r.mode === transportFilter))
      : [];
    const base = network.routes.filter((r) => transportFilter === "all" ? (r.mode === "ptMetro" || r.mode === "ptTram") : r.mode === transportFilter);
    const map = new Map<string, (typeof network.routes)[number]>();
    for (const r of base) {
      const k = `${r.lineId}-${r.mode}`;
      const ex = map.get(k);
      if (!ex || r.positions.length > ex.positions.length) map.set(k, r);
    }
    for (const r of sel) {
      const k = `${r.lineId}-${r.mode}`;
      const ex = map.get(k);
      if (!ex || (selectedStation && !ex.stationIds.includes(selectedStation.id)) || r.positions.length > ex.positions.length) map.set(k, r);
    }
    return Array.from(map.values()).slice(0, transportFilter === "ptBus" ? 420 : 900);
  }, [network, selectedStation, transportFilter]);

  const markerStations = useMemo(() => {
    if (!network) return [];
    const q = normalizeSearch(searchQuery);
    const ids = new Set([...favoriteIds, ...(selectedStation ? [selectedStation.id] : []), ...nearbyStations.map((n) => n.station.id)]);
    return network.stations.filter((s) => {
      if (ids.has(s.id)) return true;
      if (q) return searchResults.some((r) => r.id === s.id);
      if (!stationMatchesFilter(s, transportFilter)) return false;
      if (transportFilter === "all") return s.modes.includes("ptMetro") || mapZoom >= 14;
      return transportFilter !== "ptBus" || mapZoom >= 12;
    });
  }, [favoriteIds, mapZoom, nearbyStations, network, searchQuery, searchResults, selectedStation, transportFilter]);

  const departureGroups = useMemo(() => {
    if (!departures) return [];
    return createDepartureGroups(departures.departures, transportFilter);
  }, [departures, transportFilter]);

  const selectedIsFavorite = selectedStation ? favoriteIds.includes(selectedStation.id) : false;
  const lastUpdated = departures?.fetchedAt.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const visibleStationLines = selectedStation?.lines.filter((line) => {
    const mode = lineModesByName.get(line);
    return transportFilter === "all" || mode === transportFilter;
  }) ?? [];
  const nextGroup = departureGroups[0] ?? null;
  const nextDeparture = nextGroup?.departures[0] ?? null;
  const nextCountdown = nextDeparture?.countdown ?? null;
  const emptyDepartureMessage = !selectedStation ? "Station auswählen."
    : transportFilter === "all" ? "Keine aktuellen Abfahrten."
    : `Keine ${modeLabel(transportFilter)}-Abfahrten gefunden.`;

  return (
    <main className="app-shell">
      {/* TOP HEADER BAR */}
      <header className="top-bar">
        <div className="top-brand">
          <div className="brand-mark">U</div>
          <div>
            <h1>U-Time</h1>
            <p>Live · Wien</p>
          </div>
          <span className="top-divider" />
          <span className={`live-pill ${lastUpdated ? "on" : ""}`}>
            <span className="dot" />
            {lastUpdated ? `Live · ${lastUpdated}` : "Verbinde…"}
          </span>
        </div>

        <div className="top-search">
          <Search size={16} aria-hidden="true" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Station, Linie oder Adresse"
            type="search"
          />
          {searchQuery ? (
            <button className="icon-button ghost" type="button" onClick={() => setSearchQuery("")} aria-label="Suche löschen">
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="top-filter" aria-label="Verkehrsmittel">
          {transportFilters.map((f) => (
            <button key={f} className={transportFilter === f ? "active" : ""} type="button" onClick={() => setTransportFilter(f)}>
              {modeLabel(f)}
            </button>
          ))}
        </div>
      </header>

      {/* CONTENT GRID */}
      <div className="content-grid">
        {/* LEFT SIDEBAR */}
        <aside className="side-panel">
          <section className="section-block">
            <div className="section-heading">
              <h2>Standort</h2>
              <button className="icon-text-button" type="button" onClick={locateNearestStation} disabled={!network || geoStatus === "loading"}>
                <LocateFixed size={15} />
                {geoStatus === "loading" ? "Suche" : "Nächste"}
              </button>
            </div>
            {geoStatus === "error" ? <p className="status-text warning">Standort konnte nicht ermittelt werden.</p> : null}
            {nearbyStations.length ? (
              <div className="compact-list">
                {nearbyStations.map(({ station, distance }) => (
                  <StationButton key={station.id} station={station} detail={formatDistance(distance)}
                    selected={station.id === selectedStation?.id} lineModesByName={lineModesByName}
                    filter={transportFilter} onSelect={selectStation} />
                ))}
              </div>
            ) : <p className="status-text">Noch kein Standort aktiv.</p>}
          </section>

          <section className="section-block">
            <div className="section-heading">
              <h2>{searchQuery ? "Treffer" : "Favoriten"}</h2>
            </div>

            {!searchQuery ? (
              <div className="mini-tabs" aria-label="Favoritenansicht">
                <button className={favoritesTab === "stations" ? "active" : ""} type="button" onClick={() => setFavoritesTab("stations")}>Stationen</button>
                <button className={favoritesTab === "departures" ? "active" : ""} type="button" onClick={() => setFavoritesTab("departures")}>Abfahrten</button>
              </div>
            ) : null}

            <div className="compact-list">
              {searchQuery
                ? searchResults.map((s) => (
                    <StationButton key={s.id} station={s} selected={s.id === selectedStation?.id}
                      lineModesByName={lineModesByName} filter={transportFilter} onSelect={selectStation} />
                  ))
                : favoritesTab === "stations"
                  ? favoriteStations.map((s) => (
                      <StationButton key={s.id} station={s} selected={s.id === selectedStation?.id}
                        lineModesByName={lineModesByName} filter={transportFilter} onSelect={selectStation} />
                    ))
                  : favoriteStations.slice(0, MAX_FAVORITE_FEEDS).map((s) => (
                      <FavoriteDepartureCard key={s.id} station={s} feed={favoriteFeeds[s.id]}
                        filter={transportFilter} lineModesByName={lineModesByName} onSelect={selectStation} />
                    ))}
            </div>
            {searchQuery && searchResults.length === 0 ? <p className="status-text">Keine Station gefunden.</p> : null}
            {!searchQuery && favoriteStations.length === 0 ? <p className="status-text">Favoriten erscheinen hier.</p> : null}
            {!searchQuery && favoritesTab === "departures" && favoriteFeedError ? <p className="status-text warning">{favoriteFeedError}</p> : null}
          </section>

          <footer className="data-footer">
            Quelle: <a href="https://www.wienerlinien.at/open-data" target="_blank" rel="noreferrer">Wiener Linien Open Data</a>
          </footer>
        </aside>

        {/* CENTER: MAP STAGE */}
        <section className="map-stage">
          <MapContainer
            center={WIEN_CENTER}
            zoom={12}
            minZoom={10}
            zoomControl={false}
            className="leaflet-map"
          >
            <ZoomControl position="bottomleft" />
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <ZoomState onZoomChange={setMapZoom} />
            <MapFocus station={selectedStation} userLocation={userLocation} />

            {visibleRoutes.map((route) => {
              const opts: PathOptions = {
                color: route.color, weight: route.mode === "ptMetro" ? 4 : 2,
                opacity: selectedStation && route.stationIds.includes(selectedStation.id) ? 0.76 : 0.26,
              };
              return <Polyline key={route.id} positions={route.positions} pathOptions={opts} />;
            })}

            {markerStations.map((s) => {
              const sel = s.id === selectedStation?.id;
              const sm = s.modes.includes("ptMetro") ? "ptMetro" : s.modes[0];
              const c = lineColor({ name: s.lines.find((l) => l.startsWith("U")) ?? s.lines[0] ?? "", mode: sm });
              return (
                <CircleMarker key={s.id} center={[s.lat, s.lon]}
                  radius={sel ? 7 : s.modes.includes("ptMetro") ? 5 : 3.5}
                  pathOptions={{ color: c, fillColor: sel ? "#ffffff" : c, fillOpacity: sel ? 1 : 0.82, opacity: 0.95, weight: sel ? 4 : 2 }}
                  eventHandlers={{ click: () => selectStation(s) }}>
                  <Tooltip direction="top" offset={[0, -8]}>
                    <strong>{s.name}</strong>
                    <span className="tooltip-lines">{s.lines.slice(0, 5).join(" · ")}</span>
                  </Tooltip>
                </CircleMarker>
              );
            })}

            {userLocation ? (
              <CircleMarker center={[userLocation.lat, userLocation.lon]} radius={8}
                pathOptions={{ color: "#14532d", fillColor: "#22c55e", fillOpacity: 0.88, weight: 3 }}>
                <Tooltip>Dein Standort</Tooltip>
              </CircleMarker>
            ) : null}
          </MapContainer>

          {/* HERO OVERLAY (top-left) */}
          {selectedStation ? (
            <div className="hero-card">
              <div className="hero-eyebrow">
                <MapPinned size={12} /> Aktuelle Station
              </div>
              <h2 className="hero-title">{selectedStation.name}</h2>
              <div className="hero-lines">
                {visibleStationLines.length
                  ? visibleStationLines.slice(0, 6).map((l) => <LineBadge key={l} line={l} mode={lineModesByName.get(l)} />)
                  : <span className="hero-mode">{modeLabel(transportFilter)}</span>}
              </div>
              <div className="hero-stats">
                <div>
                  <span className="hero-label">Nächste</span>
                  <strong className={nextCountdown !== null && nextCountdown <= 1 ? "hero-soon" : ""}>
                    {nextCountdown === null ? "—" : nextCountdown <= 0 ? "jetzt" : `${nextCountdown} min`}
                  </strong>
                </div>
                <div className="hero-direction">
                  <span className="hero-label">Richtung</span>
                  {nextGroup ? (
                    <span className="hero-direction-summary">
                      <LineBadge line={nextGroup.line} mode={nextGroup.type} />
                      <span>{nextGroup.towards}</span>
                    </span>
                  ) : (
                    <span className="hero-empty">—</span>
                  )}
                </div>
                <div className="hero-actions">
                  <button className="icon-button" type="button" onClick={() => void refreshDepartures()} disabled={!selectedStation || isLoadingDepartures} aria-label="Aktualisieren" title="Aktualisieren">
                    <RefreshCw size={15} className={isLoadingDepartures ? "spin" : ""} />
                  </button>
                  <button className={`icon-button ${selectedIsFavorite ? "favorite" : ""}`} type="button" onClick={toggleFavorite} disabled={!selectedStation} aria-label={selectedIsFavorite ? "Favorit entfernen" : "Favorit hinzufügen"} title={selectedIsFavorite ? "Favorit entfernen" : "Favorit hinzufügen"}>
                    <Star size={15} fill={selectedIsFavorite ? "currentColor" : "none"} />
                  </button>
                </div>
              </div>
            </div>
          ) : null}

        </section>

        {/* RIGHT: TIMELINE */}
        <aside className="departure-panel">
          <div className="departure-header">
            <span className="eyebrow">
              <Clock3 size={11} aria-hidden />
              {lastUpdated ? `Aktualisiert ${lastUpdated}` : "Live"}
            </span>
            <h2>{selectedStation?.name ?? "Station auswählen"}</h2>
            {selectedStation ? (
              <div className="departure-line-strip">
                {visibleStationLines.length
                  ? visibleStationLines.slice(0, 8).map((l) => <LineBadge key={l} line={l} mode={lineModesByName.get(l)} />)
                  : <span>{modeLabel(transportFilter)}</span>}
                {visibleStationLines.length > 8 ? <span className="more-lines">+{visibleStationLines.length - 8}</span> : null}
              </div>
            ) : null}
          </div>

          {networkError ? <div className="notice error"><AlertCircle size={16} /><span>{networkError}</span></div> : null}
          {departureError ? <div className="notice error"><AlertCircle size={16} /><span>{departureError}</span></div> : null}
          {departures?.disruptions.map((m) => (
            <div className="notice" key={m}><AlertCircle size={16} /><span>{m}</span></div>
          ))}

          <div className="timeline-list">
            {departureGroups.length
              ? departureGroups.map((g) => <TimelineRow key={g.id} group={g} />)
              : (
                <div className="empty-state">
                  <Clock3 size={20} />
                  <span>{isLoadingDepartures ? "Abfahrten werden geladen." : emptyDepartureMessage}</span>
                </div>
              )}
          </div>
        </aside>
      </div>
    </main>
  );
}

export default App;
