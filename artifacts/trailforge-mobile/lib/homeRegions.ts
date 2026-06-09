/** UK & Ireland home riding regions for rider profiles. */
export const HOME_REGIONS = [
  "Wales",
  "Scotland",
  "Northern Ireland",
  "Republic of Ireland",
  "North West England",
  "North East England",
  "Yorkshire",
  "Midlands",
  "South West England",
  "South East England",
  "East Anglia",
  "Other",
] as const;

export type HomeRegion = (typeof HOME_REGIONS)[number];
