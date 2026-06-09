/**
 * Cold-start loader — ride POV image while fonts / routing initialise.
 */
import React from "react";

import { RidePovLoadingView } from "@/components/RidePovLoadingView";

export function BrandedLoader() {
  return <RidePovLoadingView message="Loading TrailForge…" />;
}
