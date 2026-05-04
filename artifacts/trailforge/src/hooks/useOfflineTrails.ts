import { useEffect, useState, useCallback } from "react";
import {
  listOfflineTrails,
  type OfflineTrail,
  isTrailOffline,
  subscribeOfflineStoreChanges,
} from "@/lib/offlineStore";

export function useOfflineTrails(): {
  trails: OfflineTrail[];
  loading: boolean;
  refresh: () => void;
} {
  const [trails, setTrails] = useState<OfflineTrail[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    void listOfflineTrails()
      .then((list) => {
        setTrails(list);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    return subscribeOfflineStoreChanges(refresh);
  }, [refresh]);

  return { trails, loading, refresh };
}

export function useIsTrailOffline(trailId: string): boolean {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    void isTrailOffline(trailId).then(setOffline).catch(() => setOffline(false));
    return subscribeOfflineStoreChanges(() => {
      void isTrailOffline(trailId).then(setOffline).catch(() => setOffline(false));
    });
  }, [trailId]);

  return offline;
}
