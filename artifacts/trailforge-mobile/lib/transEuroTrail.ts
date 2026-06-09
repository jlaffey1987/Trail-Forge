/** Trans Euro Trail — link-out + personal GPX import (file stays on device). */

export const TRANS_EURO_TRAIL = {
  websiteUrl: "https://transeurotrail.org/",
  downloadUrl: "https://transeurotrail.org/united-kingdom/",
  personalGpxStorageKey: "@trailforge/personal-gpx/trans-euro-trail-v1",
  /** DB collection names — hide from generic featured list when present. */
  collectionNames: ["Trans Euro Trail", "TET UK", "Trans Euro Trail UK"],
} as const;

export const TRANS_EURO_TRAIL_ABOUT = [
  "The Trans Euro Trail (TET) is a free, volunteer-built network of off-road and adventure routes across Europe — designed for adventure motorcycles, dual-sports, and capable trail bikes.",
  "Routes are maintained by local contributors in each country. The official GPX files come from the Trans Euro Trail project at transeurotrail.org — that is their route, their data, and their community.",
  "TrailForge does not host or redistribute those files. You download the GPX from their site and import it here for your own personal use on this device.",
  "Once imported, Premium lets you ride with turn-by-turn guidance along your track and use difficulty filters on the map while you plan and explore.",
] as const;

export const TRANS_EURO_TRAIL_IMPORT_STEPS = [
  {
    step: "1",
    title: "Download the official GPX",
    body: "Open the Trans Euro Trail website and download the UK route file to your phone (or transfer it from a computer).",
  },
  {
    step: "2",
    title: "Import into TrailForge",
    body: "Tap Import GPX below and choose the file you downloaded. It is saved only on this device — not uploaded or shared.",
  },
  {
    step: "3",
    title: "Ride with Premium",
    body: "Start navigation on your imported route, and use map filters to tailor how challenging you want each day to be.",
  },
] as const;
