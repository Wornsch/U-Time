import type { LineInfo, Station, TransportFilter, TransportMode } from "./types";

export const WIEN_CENTER: [number, number] = [48.2082, 16.3738];

const metroColors: Record<string, string> = {
  U1: "#e31b23",
  U2: "#8b3f97",
  U3: "#f07d00",
  U4: "#00a859",
  U5: "#00a1de",
  U6: "#8c5a2b",
};

export function lineColor(line: Pick<LineInfo, "name" | "mode">): string {
  if (line.mode === "ptMetro" && metroColors[line.name]) {
    return metroColors[line.name];
  }
  if (line.mode === "ptTram") {
    return "#c62828";
  }
  if (line.mode === "ptBus") {
    return "#1769aa";
  }
  if (line.mode === "ptTrain") {
    return "#2d7d46";
  }
  return "#5b6572";
}

export function modeLabel(mode: TransportMode | TransportFilter): string {
  switch (mode) {
    case "ptMetro":
      return "U-Bahn";
    case "ptTram":
      return "Bim";
    case "ptBus":
      return "Bus";
    case "ptTrain":
      return "S-Bahn";
    case "all":
      return "Alle";
    default:
      return "Öffi";
  }
}

export function stationMatchesFilter(station: Station, filter: TransportFilter): boolean {
  return filter === "all" || station.modes.includes(filter);
}

export function distanceInMeters(
  a: Pick<Station, "lat" | "lon">,
  b: { lat: number; lon: number },
): number {
  const earthRadius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
}

export function formatDepartureTime(value: string | null): string {
  if (!value) {
    return "--:--";
  }
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return date.toLocaleTimeString("de-AT", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return lat > 47 && lat < 49 && lon > 15 && lon < 18;
}
