import { useEffect, useRef } from "react";

/** Subscribes to a backend WebSocket path and calls onMessage for each
 * parsed JSON message, reconnecting automatically on close. */
export function useSocket<T>(path: string, onMessage: (data: T) => void): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${window.location.host}${path}`);
      socket.onmessage = (ev: MessageEvent<string>) => {
        onMessageRef.current(JSON.parse(ev.data) as T);
      };
      socket.onclose = () => {
        if (!cancelled) retryTimer = setTimeout(connect, 1000);
      };
    }
    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [path]);
}
