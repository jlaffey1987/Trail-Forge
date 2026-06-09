import { DiscoveryRouteScreen } from "@/components/routes/DiscoveryRouteScreen";
import { DISCOVERY_ROUTES } from "@/lib/discoveryRouteConfig";

export default function TransNorthernTrailScreen() {
  return <DiscoveryRouteScreen config={DISCOVERY_ROUTES.tnt} />;
}
