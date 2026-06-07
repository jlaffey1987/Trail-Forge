import * as Location from "expo-location";

const FRESH_MS = 30_000;

/** Prefer a recent GPS fix; otherwise request a fresh high-accuracy reading. */
export async function getAccuratePosition(): Promise<Location.LocationObject> {
  const last = await Location.getLastKnownPositionAsync({});
  if (last && Date.now() - last.timestamp < FRESH_MS) {
    return last;
  }
  return Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
}
