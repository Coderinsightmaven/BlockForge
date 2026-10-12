import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RealtimeClient, defaultRealtimeUrl } from "./client";
import type { RealtimeEvent, RealtimeStatus } from "./client";

const RealtimeContext = createContext<RealtimeClient | null>(null);

const IDLE_STATUS: RealtimeStatus = { state: "idle", attempt: 0, nextRetryAt: null, lastOpenedAt: null };

/**
 * Owns the app's single realtime connection for the signed-in session. After a reconnect all
 * active queries are invalidated because events missed while disconnected are not replayed.
 */
export function RealtimeProvider({
  children,
  client: injected,
}: {
  children: ReactNode;
  client?: RealtimeClient;
}) {
  const queryClient = useQueryClient();
  const [client] = useState(() => injected ?? new RealtimeClient({ url: defaultRealtimeUrl }));

  useEffect(() => {
    client.start();
    const offReconnect = client.onReconnect(() => {
      void queryClient.invalidateQueries({ refetchType: "active" });
    });
    const offError = client.onTopicError((e) => {
      console.warn(`[realtime] ${e.topic ?? "connection"}: ${e.code} ${e.message}`);
    });
    // After sleep / backgrounding / a network change the socket may be half-open while still
    // reporting OPEN, so re-validate it (probe ping) rather than trusting readyState.
    const online = () => client.checkHealth();
    const visible = () => {
      if (document.visibilityState === "visible") client.checkHealth();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      offReconnect();
      offError();
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
      client.stop();
    };
  }, [client, queryClient]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeClient(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

/**
 * Subscribe to a topic for the lifetime of the component. `topic = null` disables the
 * subscription (e.g. while the user lacks the permission). The latest `onEvent` is always
 * used without resubscribing.
 */
export function useRealtimeTopic(topic: string | null, onEvent: (event: RealtimeEvent) => void): void {
  const client = useRealtimeClient();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!client || !topic) return;
    return client.subscribe(topic, (e) => handler.current(e));
  }, [client, topic]);
}

export function useRealtimeStatus(): RealtimeStatus {
  const client = useRealtimeClient();
  return useSyncExternalStore(
    (cb) => (client ? client.onStatus(cb) : () => {}),
    () => (client ? client.getStatus() : IDLE_STATUS),
    () => IDLE_STATUS,
  );
}
