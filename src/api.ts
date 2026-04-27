import Papa from "papaparse";
import type {
  Departure,
  DepartureFeed,
  LineInfo,
  NetworkData,
  RoutePath,
  Station,
  TransportMode,
} from "./types";
import { isValidCoordinate, lineColor, normalizeSearch } from "./utils";

const OGD_BASE = "/api/wl/ogd_realtime/doku/ogd";

interface StopPointRow {
  StopID: string;
  DIVA: string;
  StopText: string;
  Municipality: string;
  Longitude: string;
  Latitude: string;
}

interface StationRow {
  DIVA: string;
  PlatformText: string;
  Municipality: string;
  Longitude: string;
  Latitude: string;
}

interface LineRow {
  LineID: string;
  LineText: string;
  SortingHelp: string;
  Realtime: string;
  MeansOfTransport: string;
}

interface RouteRow {
  LineID: string;
  PatternID: string;
  StopSeqCount: string;
  StopID: string;
  Direction: string;
}

interface MonitorResponse {
  data?: {
    monitors?: Monitor[];
  };
  message?: {
    value?: string;
    messageCode?: number;
  };
}

interface Monitor {
  locationStop?: {
    properties?: {
      title?: string;
      attributes?: {
        rbl?: number | string;
      };
    };
  };
  lines?: MonitorLine[];
}

interface MonitorLine {
  name?: string;
  towards?: string;
  direction?: string;
  richtungsId?: string;
  platform?: string;
  barrierFree?: boolean;
  realtimeSupported?: boolean;
  trafficjam?: boolean;
  departures?: {
    departure?: MonitorDeparture[];
  };
  type?: string;
  vehicle?: MonitorVehicle;
}

interface MonitorDeparture {
  departureTime?: {
    timePlanned?: string;
    timeReal?: string;
    countdown?: number;
  };
  vehicle?: MonitorVehicle;
}

interface MonitorVehicle {
  name?: string;
  towards?: string;
  direction?: string;
  richtungsId?: string;
  platform?: string;
  barrierFree?: boolean;
  realtimeSupported?: boolean;
  trafficjam?: boolean;
  type?: string;
}

function parseCsv<T>(csv: string): T[] {
  const result = Papa.parse<T>(csv, {
    header: true,
    delimiter: ";",
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  const fatalError = result.errors.find((error) => error.type !== "FieldMismatch");
  if (fatalError) {
    throw new Error(fatalError.message || "CSV konnte nicht gelesen werden.");
  }

  return result.data;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} beim Laden von ${path}`);
  }
  return response.text();
}

function toMode(value: string | undefined): TransportMode {
  if (value === "ptMetro") {
    return "ptMetro";
  }
  if (value === "ptTram" || value === "ptTramWLB") {
    return "ptTram";
  }
  if (value === "ptBus" || value === "ptBusCity" || value === "ptBusNight" || value === "ptRufBus") {
    return "ptBus";
  }
  if (value === "ptTrain" || value === "ptTrainS") {
    return "ptTrain";
  }
  return "unknown";
}

function parseNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function pickStationName(names: string[]): string {
  const cleanNames = names
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  return cleanNames[0] || "Unbekannte Station";
}

export async function loadNetworkData(): Promise<NetworkData> {
  const [stopPointsCsv, stationCsv, linesCsv, routesCsv] = await Promise.all([
    fetchText(`${OGD_BASE}/wienerlinien-ogd-haltepunkte.csv`),
    fetchText(`${OGD_BASE}/wienerlinien-ogd-haltestellen.csv`),
    fetchText(`${OGD_BASE}/wienerlinien-ogd-linien.csv`),
    fetchText(`${OGD_BASE}/wienerlinien-ogd-fahrwegverlaeufe.csv`),
  ]);

  const stopRows = parseCsv<StopPointRow>(stopPointsCsv);
  const stationRows = parseCsv<StationRow>(stationCsv);
  const lineRows = parseCsv<LineRow>(linesCsv);
  const routeRows = parseCsv<RouteRow>(routesCsv);

  const linesById = new Map<number, LineInfo>();
  for (const row of lineRows) {
    const id = Number(row.LineID);
    if (!Number.isFinite(id)) {
      continue;
    }
    const line: LineInfo = {
      id,
      name: row.LineText,
      sorting: Number(row.SortingHelp) || id,
      realtime: row.Realtime === "1",
      mode: toMode(row.MeansOfTransport),
      color: "#5b6572",
    };
    line.color = lineColor(line);
    linesById.set(id, line);
  }

  const stationMetaByDiva = new Map<string, StationRow>();
  for (const row of stationRows) {
    if (row.DIVA) {
      stationMetaByDiva.set(row.DIVA, row);
    }
  }

  const rawStopsById = new Map<
    number,
    { diva: string | null; name: string; municipality: string; lat: number; lon: number }
  >();
  const stationGroups = new Map<
    string,
    {
      diva: string | null;
      names: string[];
      municipality: string;
      rbls: number[];
      latValues: number[];
      lonValues: number[];
      lineIds: Set<number>;
    }
  >();

  for (const row of stopRows) {
    const rbl = Number(row.StopID);
    const lat = parseNumber(row.Latitude);
    const lon = parseNumber(row.Longitude);
    if (!Number.isFinite(rbl) || lat === null || lon === null || !isValidCoordinate(lat, lon)) {
      continue;
    }

    const diva = row.DIVA?.trim() || null;
    const fallbackGroupId = `stop-${rbl}`;
    const groupId = diva ? `diva-${diva}` : fallbackGroupId;
    const meta = diva ? stationMetaByDiva.get(diva) : undefined;
    const metaLat = parseNumber(meta?.Latitude);
    const metaLon = parseNumber(meta?.Longitude);

    rawStopsById.set(rbl, {
      diva,
      name: row.StopText,
      municipality: row.Municipality || meta?.Municipality || "Wien",
      lat,
      lon,
    });

    if (!stationGroups.has(groupId)) {
      stationGroups.set(groupId, {
        diva,
        names: [],
        municipality: row.Municipality || meta?.Municipality || "Wien",
        rbls: [],
        latValues:
          metaLat !== null && metaLon !== null && isValidCoordinate(metaLat, metaLon)
            ? [metaLat]
            : [],
        lonValues:
          metaLat !== null && metaLon !== null && isValidCoordinate(metaLat, metaLon)
            ? [metaLon]
            : [],
        lineIds: new Set<number>(),
      });
    }

    const group = stationGroups.get(groupId);
    if (!group) {
      continue;
    }
    group.names.push(meta?.PlatformText || row.StopText);
    group.rbls.push(rbl);
    group.latValues.push(lat);
    group.lonValues.push(lon);
  }

  const stationIdByStopId = new Map<number, string>();
  for (const [groupId, group] of stationGroups) {
    for (const rbl of group.rbls) {
      stationIdByStopId.set(rbl, groupId);
    }
  }

  for (const row of routeRows) {
    const stopId = Number(row.StopID);
    const lineId = Number(row.LineID);
    const stationId = stationIdByStopId.get(stopId);
    if (stationId && Number.isFinite(lineId)) {
      stationGroups.get(stationId)?.lineIds.add(lineId);
    }
  }

  const stations: Station[] = Array.from(stationGroups.entries())
    .map(([id, group]) => {
      const lineInfos = Array.from(group.lineIds)
        .map((lineId) => linesById.get(lineId))
        .filter((line): line is LineInfo => Boolean(line))
        .sort((a, b) => a.sorting - b.sorting);
      const modes = Array.from(new Set(lineInfos.map((line) => line.mode)));
      const lines = Array.from(new Set(lineInfos.map((line) => line.name)));
      const lat =
        group.latValues.reduce((sum, value) => sum + value, 0) / Math.max(1, group.latValues.length);
      const lon =
        group.lonValues.reduce((sum, value) => sum + value, 0) / Math.max(1, group.lonValues.length);

      return {
        id,
        diva: group.diva,
        name: pickStationName(group.names),
        municipality: group.municipality,
        lat,
        lon,
        rbls: Array.from(new Set(group.rbls)).sort((a, b) => a - b),
        lines,
        modes,
        stopCount: group.rbls.length,
      };
    })
    .filter((station) => station.lines.length > 0)
    .sort((a, b) => normalizeSearch(a.name).localeCompare(normalizeSearch(b.name), "de"));

  const routeGroups = new Map<
    string,
    {
      line: LineInfo;
      direction: string;
      points: { seq: number; stopId: number }[];
      stationIds: Set<string>;
    }
  >();

  for (const row of routeRows) {
    const lineId = Number(row.LineID);
    const line = linesById.get(lineId);
    const stopId = Number(row.StopID);
    const seq = Number(row.StopSeqCount);
    const stationId = stationIdByStopId.get(stopId);
    if (!line || !Number.isFinite(stopId) || !Number.isFinite(seq) || !stationId) {
      continue;
    }

    const groupId = `${row.LineID}-${row.PatternID}-${row.Direction}`;
    if (!routeGroups.has(groupId)) {
      routeGroups.set(groupId, {
        line,
        direction: row.Direction,
        points: [],
        stationIds: new Set<string>(),
      });
    }
    const group = routeGroups.get(groupId);
    group?.points.push({ seq, stopId });
    group?.stationIds.add(stationId);
  }

  const routes: RoutePath[] = Array.from(routeGroups.entries())
    .map(([id, group]) => {
      const positions = group.points
        .sort((a, b) => a.seq - b.seq)
        .map((point) => rawStopsById.get(point.stopId))
        .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop))
        .map((stop): [number, number] => [stop.lat, stop.lon]);

      return {
        id,
        lineId: group.line.id,
        lineName: group.line.name,
        mode: group.line.mode,
        color: group.line.color,
        direction: group.direction,
        positions,
        stationIds: Array.from(group.stationIds),
      };
    })
    .filter((route) => route.positions.length > 1);

  return {
    stations,
    routes,
    linesById,
  };
}

export async function fetchDepartures(rbls: number[]): Promise<DepartureFeed> {
  const params = new URLSearchParams();
  for (const rbl of rbls.slice(0, 35)) {
    params.append("rbl", String(rbl));
  }
  params.append("activateTrafficInfo", "stoerungkurz");
  params.append("activateTrafficInfo", "stoerunglang");
  params.append("activateTrafficInfo", "aufzugsinfo");

  const response = await fetch(`/api/wl/ogd_realtime/monitor?${params.toString()}`, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} beim Laden der Abfahrten.`);
  }

  const json = (await response.json()) as MonitorResponse;
  const monitors = json.data?.monitors ?? [];
  const departures: Departure[] = [];
  const disruptions = new Set<string>();

  for (const monitor of monitors) {
    const stationTitle = monitor.locationStop?.properties?.title || "Station";
    const rblValue = monitor.locationStop?.properties?.attributes?.rbl;
    const rbl = rblValue === undefined ? null : Number(rblValue);

    for (const line of monitor.lines ?? []) {
      for (const departure of line.departures?.departure ?? []) {
        const vehicle = departure.vehicle ?? line.vehicle;
        const departureTime = departure.departureTime;
        const lineName = vehicle?.name || line.name || "?";
        const towards = vehicle?.towards || line.towards || "Unbekanntes Ziel";
        const timeReal = departureTime?.timeReal ?? null;
        const timePlanned = departureTime?.timePlanned ?? null;
        const countdown =
          typeof departureTime?.countdown === "number" ? departureTime.countdown : null;
        const id = `${rbl ?? "x"}-${lineName}-${towards}-${timeReal ?? timePlanned ?? countdown}`;

        departures.push({
          id,
          line: lineName,
          towards,
          direction: vehicle?.direction || line.direction || null,
          directionId: vehicle?.richtungsId || line.richtungsId || null,
          countdown,
          timePlanned,
          timeReal,
          platform: vehicle?.platform || line.platform || null,
          type: toMode(vehicle?.type || line.type),
          realtimeSupported: Boolean(vehicle?.realtimeSupported ?? line.realtimeSupported),
          barrierFree: Boolean(vehicle?.barrierFree ?? line.barrierFree),
          trafficjam: Boolean(vehicle?.trafficjam ?? line.trafficjam),
          stationTitle,
          rbl: Number.isFinite(rbl) ? rbl : null,
        });
      }
    }
  }

  if (json.message?.value && json.message.value.toLowerCase() !== "ok") {
    disruptions.add(json.message.value);
  }

  return {
    departures: departures
      .sort((a, b) => (a.countdown ?? 999) - (b.countdown ?? 999))
      .slice(0, 48),
    disruptions: Array.from(disruptions),
    fetchedAt: new Date(),
  };
}
