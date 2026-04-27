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

function MapFocus({
  station,
  userLocation,
}: {
  station: Station | null;
  userLocation: UserLocation | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (station) {
      map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 15), {
        duration: 0.7,
      });
      return;
    }

    if (userLocation) {
      map.flyTo([userLocation.lat, userLocation.lon], Math.max(map.getZoom(), 14), {
        duration: 0.7,
      });
    }
  }, [map, station, userLocation]);

  return null;
}

function ZoomState({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  useMapEvents({
    zoomend(event) {
      onZoomChange(event.target.getZoom());
    },
  });
  return null;
}

function LineBadge({ line, mode }: { line: string; mode?: TransportMode }) {
  const color = lineColor({ name: line, mode: mode ?? (line.startsWith("U") ? "ptMetro" : "unknown") });
  const textColor = readableTextColor(color);
  return (
    <span
      className="line-badge"
      style={{ "--line-color": color, "--line-text-color": textColor } as CSSProperties}
    >
      {line}
    </span>
  );
}

function readableTextColor(hexColor: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor);
  if (!match) {
    return "#ffffff";
  }

  const [, red, green, blue] = match;
  const luminance =
    (0.2126 * Number.parseInt(red, 16) +
      0.7152 * Number.parseInt(green, 16) +
      0.0722 * Number.parseInt(blue, 16)) /
    255;

  return luminance > 0.48 ? "#101820" : "#ffffff";
}

function StationMeta({
  station,
  lineModesByName,
  filter = "all",
}: {
  station: Station;
  lineModesByName?: Map<string, TransportMode>;
  filter?: TransportFilter;
}) {
  const matchingLines = station.lines.filter((line) => {
    const mode = lineModesByName?.get(line);
    return filter === "all" || mode === filter;
  });
  const visibleLines = matchingLines.length ? matchingLines : station.lines;

  return (
    <div className="station-meta">
      {visibleLines.slice(0, 7).map((line) => (
        <LineBadge key={line} line={line} mode={lineModesByName?.get(line) ?? station.modes[0]} />
      ))}
      {visibleLines.length > 7 ? <span className="more-lines">+{visibleLines.length - 7}</span> : null}
    </div>
  );
}

function departureMatchesFilter(departure: Departure, filter: TransportFilter): boolean {
  return filter === "all" || departure.type === filter;
}

function departureWaitLabel(departure: Departure): string {
  const countdown = departure.countdown;
  if (countdown === null) {
    return formatDepartureTime(departure.timeReal ?? departure.timePlanned);
  }
  return countdown <= 0 ? "jetzt" : `${countdown} min`;
}

function directionKey(departure: Departure): string {
  return [
    departure.type,
    departure.line,
    departure.directionId || departure.direction || departure.platform || departure.towards,
    departure.platform ?? "",
  ].join("-");
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
      const terminalSort = Number(terminals.has(b[0])) - Number(terminals.has(a[0]));
      return terminalSort || b[1] - a[1] || a[0].localeCompare(b[0], "de");
    })
    .map(([label]) => label);

  if (labels.length === 0) {
    return "Unbekanntes Ziel";
  }

  return labels.slice(0, 2).join(" / ");
}

function createDepartureGroups(
  sourceDepartures: Departure[],
  filter: TransportFilter,
  maxGroups = MAX_DEPARTURE_GROUPS,
): DepartureGroup[] {
  const groups = new Map<
    string,
    Omit<DepartureGroup, "towards" | "departures"> & {
      departures: Departure[];
      towardsCounts: Map<string, number>;
    }
  >();

  const sortedDepartures = sourceDepartures
    .filter((departure) => departureMatchesFilter(departure, filter))
    .sort((a, b) => (a.countdown ?? 999) - (b.countdown ?? 999));

  for (const departure of sortedDepartures) {
    const groupId = directionKey(departure);
    const existingGroup = groups.get(groupId);

    if (existingGroup) {
      existingGroup.departures.push(departure);
      existingGroup.towardsCounts.set(
        departure.towards,
        (existingGroup.towardsCounts.get(departure.towards) ?? 0) + 1,
      );
      continue;
    }

    groups.set(groupId, {
      id: groupId,
      line: departure.line,
      platform: departure.platform,
      type: departure.type,
      realtimeSupported: departure.realtimeSupported,
      stationTitle: departure.stationTitle,
      departures: [departure],
      towardsCounts: new Map([[departure.towards, 1]]),
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      id: group.id,
      line: group.line,
      towards: directionLabel(group.line, group.towardsCounts),
      platform: group.platform,
      type: group.type,
      realtimeSupported: group.realtimeSupported,
      stationTitle: group.stationTitle,
      departures: group.departures.slice(0, 2),
    }))
    .sort((a, b) => (a.departures[0]?.countdown ?? 999) - (b.departures[0]?.countdown ?? 999))
    .slice(0, maxGroups);
}

function DepartureRow({ group }: { group: DepartureGroup }) {
  return (
    <article className="departure-row">
      <div className="departure-line">
        <LineBadge line={group.line} mode={group.type} />
        <div>
          <strong>{group.towards}</strong>
          <span>
            {group.platform ? `Steig ${group.platform}` : group.stationTitle}
            {group.realtimeSupported ? " · Echtzeit" : " · Planzeit"}
          </span>
        </div>
      </div>
      <div className="wait-times">
        {group.departures.map((departure, index) => (
          <span className={`wait-pill ${index === 0 ? "primary" : ""}`} key={departure.id}>
            <strong>{departureWaitLabel(departure)}</strong>
            <small>{index === 0 ? "aktuell" : "nächste"}</small>
          </span>
        ))}
      </div>
    </article>
  );
}

function StationButton({
  station,
  selected,
  detail,
  lineModesByName,
  filter,
  onSelect,
}: {
  station: Station;
  selected?: boolean;
  detail?: string;
  lineModesByName?: Map<string, TransportMode>;
  filter?: TransportFilter;
  onSelect: (station: Station) => void;
}) {
  return (
    <button
      className={`station-button ${selected ? "selected" : ""}`}
      type="button"
      onClick={() => onSelect(station)}
    >
      <span>
        <strong>{station.name}</strong>
        <span>{detail ?? station.municipality}</span>
      </span>
      <StationMeta station={station} lineModesByName={lineModesByName} filter={filter} />
    </button>
  );
}

function FavoriteDepartureCard({
  station,
  feed,
  filter,
  lineModesByName,
  onSelect,
}: {
  station: Station;
  feed: DepartureFeed | undefined;
  filter: TransportFilter;
  lineModesByName: Map<string, TransportMode>;
  onSelect: (station: Station) => void;
}) {
  const groups = feed ? createDepartureGroups(feed.departures, filter, 2) : [];

  return (
    <button className="favorite-departure-card" type="button" onClick={() => onSelect(station)}>
      <span className="favorite-card-title">
        <strong>{station.name}</strong>
        <span>
          {station.lines
            .filter((line) => filter === "all" || lineModesByName.get(line) === filter)
            .slice(0, 5)
            .join(" · ") || modeLabel(filter)}
        </span>
      </span>

      {groups.length ? (
        <span className="favorite-times">
          {groups.map((group) => (
            <span className="favorite-time-row" key={group.id}>
              <LineBadge line={group.line} mode={group.type} />
              <strong>{departureWaitLabel(group.departures[0])}</strong>
              {group.departures[1] ? <small>{departureWaitLabel(group.departures[1])}</small> : null}
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

    loadNetworkData()
      .then((data) => {
        if (!active) {
          return;
        }
        setNetwork(data);
        const preferredStart =
          data.stations.find((station) => station.name === "Stephansplatz") ??
          data.stations.find((station) => station.name === "Karlsplatz") ??
          data.stations.find((station) => station.lines.includes("U1"));
        setSelectedStationId(preferredStart?.id ?? data.stations[0]?.id ?? null);
      })
      .catch((error) => {
        if (active) {
          setNetworkError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const selectedStation = useMemo(() => {
    if (!network || !selectedStationId) {
      return null;
    }
    return network.stations.find((station) => station.id === selectedStationId) ?? null;
  }, [network, selectedStationId]);

  const lineModesByName = useMemo(() => {
    const modes = new Map<string, TransportMode>();
    for (const line of network?.linesById.values() ?? []) {
      modes.set(line.name, line.mode);
    }
    return modes;
  }, [network]);

  const favoriteStations = useMemo(() => {
    if (!network) {
      return [];
    }
    const favoriteSet = new Set(favoriteIds);
    return network.stations.filter((station) => favoriteSet.has(station.id));
  }, [favoriteIds, network]);

  useEffect(() => {
    let active = true;
    const stationsToFetch = favoriteStations.slice(0, MAX_FAVORITE_FEEDS);

    if (!stationsToFetch.length) {
      setFavoriteFeeds({});
      setFavoriteFeedError(null);
      return;
    }

    async function refreshFavoriteFeeds() {
      try {
        const results = await Promise.allSettled(
          stationsToFetch.map(async (station) => ({
            stationId: station.id,
            feed: await fetchDepartures(station.rbls),
          })),
        );

        if (!active) {
          return;
        }

        const nextFeeds: Record<string, DepartureFeed> = {};
        let failed = false;

        for (const result of results) {
          if (result.status === "fulfilled") {
            nextFeeds[result.value.stationId] = result.value.feed;
          } else {
            failed = true;
          }
        }

        setFavoriteFeeds(nextFeeds);
        setFavoriteFeedError(failed ? "Einige Favoriten konnten nicht aktualisiert werden." : null);
      } catch (error) {
        if (active) {
          setFavoriteFeedError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void refreshFavoriteFeeds();
    const interval = window.setInterval(refreshFavoriteFeeds, 45_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [favoriteStations]);

  const searchResults = useMemo(() => {
    if (!network) {
      return [];
    }
    const query = normalizeSearch(searchQuery);
    if (!query) {
      return [];
    }
    return network.stations
      .filter((station) => {
        if (!stationMatchesFilter(station, transportFilter)) {
          return false;
        }
        const haystack = normalizeSearch(`${station.name} ${station.lines.join(" ")}`);
        return haystack.includes(query);
      })
      .slice(0, 10);
  }, [network, searchQuery, transportFilter]);

  const nearbyStations = useMemo(() => {
    if (!network || !userLocation) {
      return [];
    }
    return network.stations
      .filter((station) => stationMatchesFilter(station, transportFilter))
      .map((station) => ({
        station,
        distance: distanceInMeters(station, userLocation),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 4);
  }, [network, transportFilter, userLocation]);

  const refreshDepartures = useCallback(
    async (station: Station | null = selectedStation) => {
      if (!station) {
        return;
      }
      setIsLoadingDepartures(true);
      setDepartureError(null);

      try {
        const feed = await fetchDepartures(station.rbls);
        setDepartures(feed);
      } catch (error) {
        setDepartureError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLoadingDepartures(false);
      }
    },
    [selectedStation],
  );

  useEffect(() => {
    if (!selectedStation) {
      return;
    }

    void refreshDepartures(selectedStation);
    const interval = window.setInterval(() => {
      void refreshDepartures(selectedStation);
    }, 30_000);

    return () => window.clearInterval(interval);
  }, [refreshDepartures, selectedStation]);

  const selectStation = useCallback((station: Station) => {
    setSelectedStationId(station.id);
    setSearchQuery("");
  }, []);

  const toggleFavorite = useCallback(() => {
    if (!selectedStation) {
      return;
    }

    setFavoriteIds((current) => {
      const next = current.includes(selectedStation.id)
        ? current.filter((id) => id !== selectedStation.id)
        : [selectedStation.id, ...current];
      saveFavoriteIds(next);
      return next;
    });
  }, [selectedStation]);

  const locateNearestStation = useCallback(() => {
    if (!navigator.geolocation || !network) {
      setGeoStatus("error");
      return;
    }

    setGeoStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location: UserLocation = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        setUserLocation(location);
        setGeoStatus("idle");

        const nearest = network.stations
          .filter((station) => stationMatchesFilter(station, transportFilter))
          .map((station) => ({
            station,
            distance: distanceInMeters(station, location),
          }))
          .sort((a, b) => a.distance - b.distance)[0]?.station;

        if (nearest) {
          selectStation(nearest);
        }
      },
      () => {
        setGeoStatus("error");
      },
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 30_000,
      },
    );
  }, [network, selectStation, transportFilter]);

  const visibleRoutes = useMemo(() => {
    if (!network) {
      return [];
    }
    const selectedRoutes = selectedStation
      ? network.routes.filter(
          (route) =>
            route.stationIds.includes(selectedStation.id) &&
            (transportFilter === "all" || route.mode === transportFilter),
        )
      : [];
    const baseRoutes = network.routes.filter((route) => {
      if (transportFilter === "all") {
        return route.mode === "ptMetro" || route.mode === "ptTram";
      }
      return route.mode === transportFilter;
    });

    const routeMap = new Map<string, (typeof network.routes)[number]>();
    for (const route of baseRoutes) {
      const key = `${route.lineId}-${route.mode}`;
      const existingRoute = routeMap.get(key);
      if (!existingRoute || route.positions.length > existingRoute.positions.length) {
        routeMap.set(key, route);
      }
    }

    for (const route of selectedRoutes) {
      const key = `${route.lineId}-${route.mode}`;
      const existingRoute = routeMap.get(key);
      if (
        !existingRoute ||
        (selectedStation && !existingRoute.stationIds.includes(selectedStation.id)) ||
        route.positions.length > existingRoute.positions.length
      ) {
        routeMap.set(key, route);
      }
    }
    return Array.from(routeMap.values()).slice(0, transportFilter === "ptBus" ? 420 : 900);
  }, [network, selectedStation, transportFilter]);

  const markerStations = useMemo(() => {
    if (!network) {
      return [];
    }
    const query = normalizeSearch(searchQuery);
    const selectedAndFavoriteIds = new Set([
      ...favoriteIds,
      ...(selectedStation ? [selectedStation.id] : []),
      ...nearbyStations.map(({ station }) => station.id),
    ]);

    return network.stations.filter((station) => {
      if (selectedAndFavoriteIds.has(station.id)) {
        return true;
      }
      if (query) {
        return searchResults.some((result) => result.id === station.id);
      }
      if (!stationMatchesFilter(station, transportFilter)) {
        return false;
      }
      if (transportFilter === "all") {
        return station.modes.includes("ptMetro") || mapZoom >= 14;
      }
      return transportFilter !== "ptBus" || mapZoom >= 12;
    });
  }, [
    favoriteIds,
    mapZoom,
    nearbyStations,
    network,
    searchQuery,
    searchResults,
    selectedStation,
    transportFilter,
  ]);

  const departureGroups = useMemo(() => {
    if (!departures) {
      return [];
    }
    return createDepartureGroups(departures.departures, transportFilter);
  }, [departures, transportFilter]);

  const selectedIsFavorite = selectedStation ? favoriteIds.includes(selectedStation.id) : false;
  const lastUpdated = departures?.fetchedAt.toLocaleTimeString("de-AT", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const visibleStationLines =
    selectedStation?.lines.filter((line) => {
      const mode = lineModesByName.get(line);
      return transportFilter === "all" || mode === transportFilter;
    }) ?? [];
  const emptyDepartureMessage = !selectedStation
    ? "Station auswählen."
    : transportFilter === "all"
      ? "Keine aktuellen Abfahrten."
      : `Keine ${modeLabel(transportFilter)}-Abfahrten gefunden.`;

  return (
    <main className="app-shell">
      <aside className="side-panel">
        <header className="app-header">
          <div className="brand-mark">U</div>
          <div>
            <h1>U-Time</h1>
            <p>Live-Abfahrten für Wien</p>
          </div>
        </header>

        <div className="search-box">
          <Search size={18} aria-hidden="true" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Station oder Linie suchen"
            type="search"
          />
          {searchQuery ? (
            <button
              className="icon-button ghost"
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="Suche löschen"
              title="Suche löschen"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>

        <div className="segmented-control" aria-label="Verkehrsmittel">
          {transportFilters.map((filter) => (
            <button
              key={filter}
              className={transportFilter === filter ? "active" : ""}
              type="button"
              onClick={() => setTransportFilter(filter)}
            >
              {modeLabel(filter)}
            </button>
          ))}
        </div>

        <section className="section-block">
          <div className="section-heading">
            <h2>Standort</h2>
            <button
              className="icon-text-button"
              type="button"
              onClick={locateNearestStation}
              disabled={!network || geoStatus === "loading"}
            >
              <LocateFixed size={17} />
              {geoStatus === "loading" ? "Suche" : "Nächste"}
            </button>
          </div>
          {geoStatus === "error" ? (
            <p className="status-text warning">Standort konnte nicht ermittelt werden.</p>
          ) : null}
          {nearbyStations.length ? (
            <div className="compact-list">
              {nearbyStations.map(({ station, distance }) => (
                <StationButton
                  key={station.id}
                  station={station}
                  detail={formatDistance(distance)}
                  selected={station.id === selectedStation?.id}
                  lineModesByName={lineModesByName}
                  filter={transportFilter}
                  onSelect={selectStation}
                />
              ))}
            </div>
          ) : (
            <p className="status-text">Noch kein Standort aktiv.</p>
          )}
        </section>

        <section className="section-block">
          <div className="section-heading">
            <h2>{searchQuery ? "Treffer" : "Favoriten"}</h2>
          </div>

          {!searchQuery ? (
            <div className="mini-tabs" aria-label="Favoritenansicht">
              <button
                className={favoritesTab === "stations" ? "active" : ""}
                type="button"
                onClick={() => setFavoritesTab("stations")}
              >
                Stationen
              </button>
              <button
                className={favoritesTab === "departures" ? "active" : ""}
                type="button"
                onClick={() => setFavoritesTab("departures")}
              >
                Abfahrten
              </button>
            </div>
          ) : null}

          <div className="compact-list">
            {searchQuery
              ? searchResults.map((station) => (
                  <StationButton
                    key={station.id}
                    station={station}
                    selected={station.id === selectedStation?.id}
                    lineModesByName={lineModesByName}
                    filter={transportFilter}
                    onSelect={selectStation}
                  />
                ))
              : favoritesTab === "stations"
                ? favoriteStations.map((station) => (
                    <StationButton
                      key={station.id}
                      station={station}
                      selected={station.id === selectedStation?.id}
                      lineModesByName={lineModesByName}
                      filter={transportFilter}
                      onSelect={selectStation}
                    />
                  ))
                : favoriteStations.slice(0, MAX_FAVORITE_FEEDS).map((station) => (
                    <FavoriteDepartureCard
                      key={station.id}
                      station={station}
                      feed={favoriteFeeds[station.id]}
                      filter={transportFilter}
                      lineModesByName={lineModesByName}
                      onSelect={selectStation}
                    />
                  ))}
          </div>
          {searchQuery && searchResults.length === 0 ? <p className="status-text">Keine Station gefunden.</p> : null}
          {!searchQuery && favoriteStations.length === 0 ? (
            <p className="status-text">Favoriten erscheinen hier.</p>
          ) : null}
          {!searchQuery && favoritesTab === "departures" && favoriteFeedError ? (
            <p className="status-text warning">{favoriteFeedError}</p>
          ) : null}
        </section>

        <footer className="data-footer">
          Quelle:{" "}
          <a href="https://www.wienerlinien.at/open-data" target="_blank" rel="noreferrer">
            Wiener Linien Open Data
          </a>
        </footer>
      </aside>

      <section className="map-stage">
        <div className="map-toolbar">
          <div className="toolbar-title">
            <MapPinned size={18} />
            <span>{selectedStation?.name ?? "Wien"}</span>
          </div>
          <div className="toolbar-actions">
            <button
              className="icon-button"
              type="button"
              onClick={() => void refreshDepartures()}
              disabled={!selectedStation || isLoadingDepartures}
              aria-label="Abfahrten aktualisieren"
              title="Abfahrten aktualisieren"
            >
              <RefreshCw size={17} className={isLoadingDepartures ? "spin" : ""} />
            </button>
            <button
              className={`icon-button ${selectedIsFavorite ? "favorite" : ""}`}
              type="button"
              onClick={toggleFavorite}
              disabled={!selectedStation}
              aria-label={selectedIsFavorite ? "Favorit entfernen" : "Favorit hinzufügen"}
              title={selectedIsFavorite ? "Favorit entfernen" : "Favorit hinzufügen"}
            >
              <Star size={17} fill={selectedIsFavorite ? "currentColor" : "none"} />
            </button>
          </div>
        </div>

        <MapContainer center={WIEN_CENTER} zoom={12} minZoom={10} className="leaflet-map">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ZoomState onZoomChange={setMapZoom} />
          <MapFocus station={selectedStation} userLocation={userLocation} />

          {visibleRoutes.map((route) => {
            const options: PathOptions = {
              color: route.color,
              weight: route.mode === "ptMetro" ? 4 : 2,
              opacity: selectedStation && route.stationIds.includes(selectedStation.id) ? 0.76 : 0.26,
            };
            return <Polyline key={route.id} positions={route.positions} pathOptions={options} />;
          })}

          {markerStations.map((station) => {
            const selected = station.id === selectedStation?.id;
            const stationMode = station.modes.includes("ptMetro") ? "ptMetro" : station.modes[0];
            const color = lineColor({
              name: station.lines.find((line) => line.startsWith("U")) ?? station.lines[0] ?? "",
              mode: stationMode,
            });
            return (
              <CircleMarker
                key={station.id}
                center={[station.lat, station.lon]}
                radius={selected ? 7 : station.modes.includes("ptMetro") ? 5 : 3.5}
                pathOptions={{
                  color,
                  fillColor: selected ? "#ffffff" : color,
                  fillOpacity: selected ? 1 : 0.82,
                  opacity: 0.95,
                  weight: selected ? 4 : 2,
                }}
                eventHandlers={{
                  click: () => selectStation(station),
                }}
              >
                <Tooltip direction="top" offset={[0, -8]}>
                  <strong>{station.name}</strong>
                  <span className="tooltip-lines">{station.lines.slice(0, 5).join(" · ")}</span>
                </Tooltip>
              </CircleMarker>
            );
          })}

          {userLocation ? (
            <CircleMarker
              center={[userLocation.lat, userLocation.lon]}
              radius={8}
              pathOptions={{
                color: "#14532d",
                fillColor: "#22c55e",
                fillOpacity: 0.88,
                weight: 3,
              }}
            >
              <Tooltip>Dein Standort</Tooltip>
            </CircleMarker>
          ) : null}
        </MapContainer>

        <section className="departure-panel">
          <div className="departure-header">
            <div>
              <span className="eyebrow">
                <Clock3 size={15} />
                {lastUpdated ? `Aktualisiert ${lastUpdated}` : "Live"}
              </span>
              <h2>{selectedStation?.name ?? "Station auswählen"}</h2>
              {selectedStation ? (
                <div className="departure-line-strip">
                  {visibleStationLines.length ? (
                    visibleStationLines
                      .slice(0, 9)
                      .map((line) => (
                        <LineBadge key={line} line={line} mode={lineModesByName.get(line)} />
                      ))
                  ) : (
                    <span>{modeLabel(transportFilter)}</span>
                  )}
                  {visibleStationLines.length > 9 ? (
                    <span className="more-lines">+{visibleStationLines.length - 9}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {selectedStation ? <span className="rbl-chip">{selectedStation.stopCount} Steige</span> : null}
          </div>

          {networkError ? (
            <div className="notice error">
              <AlertCircle size={18} />
              <span>{networkError}</span>
            </div>
          ) : null}
          {departureError ? (
            <div className="notice error">
              <AlertCircle size={18} />
              <span>{departureError}</span>
            </div>
          ) : null}
          {departures?.disruptions.map((message) => (
            <div className="notice" key={message}>
              <AlertCircle size={18} />
              <span>{message}</span>
            </div>
          ))}

          <div className="departure-list">
            {departureGroups.length ? (
              departureGroups.map((group) => (
                <DepartureRow key={group.id} group={group} />
              ))
            ) : (
              <div className="empty-state">
                <Clock3 size={22} />
                <span>{isLoadingDepartures ? "Abfahrten werden geladen." : emptyDepartureMessage}</span>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
