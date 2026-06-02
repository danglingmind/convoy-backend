import { ActiveRideState } from '../types';

const store = new Map<string, ActiveRideState>();

export const rideStore = {
  get: (rideId: string): ActiveRideState | undefined => store.get(rideId),
  set: (rideId: string, state: ActiveRideState): void => {
    store.set(rideId, state);
  },
  delete: (rideId: string): void => {
    store.delete(rideId);
  },
  has: (rideId: string): boolean => store.has(rideId),
};
