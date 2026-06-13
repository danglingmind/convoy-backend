export type RideStatus = 'LOBBY' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
export type ParticipantStatus = 'JOINED' | 'READY' | 'ACTIVE' | 'DISCONNECTED' | 'LEFT';
export type WaypointType = 'START' | 'WAYPOINT' | 'DESTINATION';
export type RegroupType = 'FUEL' | 'FOOD' | 'SCENIC' | 'STOP';
export type RideTitle = 'RIDE_LEADER' | 'PACE_KEEPER' | 'TRAIL_GUARDIAN' | 'FORMATION_RIDER';
export type SignalStrength = 'STRONG' | 'MODERATE' | 'WEAK';

export interface ParticipantState {
  userId: string;
  name: string;
  avatarUrl: string | null;
  status: ParticipantStatus;
  lat: number | null;
  lng: number | null;
  speed: number | null;
  heading: number | null;
  progress: number;
  offRoute: boolean;
  battery: number | null;
  signalStrength: SignalStrength | null;
  updatedAt: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  progress: number;
  gapMeters: number;
  positionDelta: number;
  title: string | null;
}

export interface ActiveRideState {
  rideId: string;
  status: RideStatus;
  leaderId: string;
  distanceMeters: number;
  routePoints: { lat: number; lng: number }[];
  cumulativeDist: number[];
  participants: Map<string, ParticipantState>;
  leaderboard: LeaderboardEntry[];
  splitActive: boolean;
  spreadSampleSum: number;
  spreadSampleCount: number;
  perRiderGapAccumulator: Map<string, { gapSum: number; gapCount: number }>;
  openRegroup: {
    regroupId: string;
    lat: number;
    lng: number;
    arrivedRiders: Set<string>;
  } | null;
}

export interface AuthUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
}
