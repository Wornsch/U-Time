export type TransportMode = "ptMetro" | "ptTram" | "ptBus" | "ptTrain" | "unknown";

export type TransportFilter = "all" | "ptMetro" | "ptTram" | "ptBus";

export interface LineInfo {
  id: number;
  name: string;
  sorting: number;
  realtime: boolean;
  mode: TransportMode;
  color: string;
}

export interface Station {
  id: string;
  diva: string | null;
  name: string;
  municipality: string;
  lat: number;
  lon: number;
  rbls: number[];
  lines: string[];
  modes: TransportMode[];
  stopCount: number;
}

export interface RoutePath {
  id: string;
  lineId: number;
  lineName: string;
  mode: TransportMode;
  color: string;
  direction: string;
  positions: [number, number][];
  stationIds: string[];
}

export interface NetworkData {
  stations: Station[];
  routes: RoutePath[];
  linesById: Map<number, LineInfo>;
}

export interface Departure {
  id: string;
  line: string;
  towards: string;
  direction: string | null;
  directionId: string | null;
  countdown: number | null;
  timePlanned: string | null;
  timeReal: string | null;
  platform: string | null;
  type: TransportMode;
  realtimeSupported: boolean;
  barrierFree: boolean;
  trafficjam: boolean;
  stationTitle: string;
  rbl: number | null;
}

export interface DepartureFeed {
  departures: Departure[];
  disruptions: string[];
  fetchedAt: Date;
}

export interface UserLocation {
  lat: number;
  lon: number;
  accuracy: number | null;
}
