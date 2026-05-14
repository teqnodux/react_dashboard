# Socket.IO Integration Guide

## Overview

This project uses a **singleton Socket.IO service** to maintain a single persistent WebSocket connection to the backend. Components subscribe to specific real-time events through this service.

- **Backend URL:** `https://rag-django-sq2f.onrender.com`
- **Library:** `socket.io-client`

---

## Architecture

```
┌─────────────┐
│   Layout     │  ← Manages connect/disconnect lifecycle
└─────┬───────┘
      │
      ▼
┌─────────────────┐
│  socketService   │  ← Singleton service (single shared instance)
│  (WebSocket)     │
└──┬──────────┬───┘
   │          │
   ▼          ▼
┌────────┐  ┌────────────┐
│NewsFeed│  │ SecFilings  │  ← Consumers: subscribe to specific events
└────────┘  └────────────┘
```

---

## 1. Socket Service (Singleton)

Create a singleton class that wraps `socket.io-client`. This ensures only one connection exists app-wide.

```typescript
import { io, Socket } from "socket.io-client";

class SocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map();

  connect() {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.socket = io("https://rag-django-sq2f.onrender.com", {
      transports: ["websocket", "polling"],
      timeout: 20000,
      path: "/socket.io"
    });

    this.socket.on("connect", () => {
      this.isConnected = true;
      this.notifyHandlers("connection_status", {
        connected: true,
        socketId: this.socket?.id
      });
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
      this.notifyHandlers("connection_status", { connected: false });
    });

    this.socket.on("connect_error", (error) => {
      this.notifyHandlers("connection_error", { error });
    });

    // Register server-pushed events here
    this.socket.on("rss_update", (data) => {
      this.notifyHandlers("rss_update", data);
    });

    this.socket.on("sec_filing_update", (data) => {
      this.notifyHandlers("sec_filing_update", data);
    });

    this.socket.on("sec_analysis_update", (data) => {
      this.notifyHandlers("sec_analysis_update", data);
    });

    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.eventHandlers.clear();
    }
  }

  on(event: string, handler: (data: unknown) => void) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(handler);
  }

  off(event: string, handler: (data: unknown) => void) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private notifyHandlers(event: string, data: unknown) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  getConnectionStatus() {
    return this.isConnected;
  }

  getSocket() {
    return this.socket;
  }
}

export const socketService = new SocketService();
```

---

## 2. Connection Lifecycle (Root Layout)

Connect when the app mounts, disconnect when it unmounts. Place this in your **root layout or App component** so the socket lives for the entire session.

```typescript
import { useEffect } from "react";
import { socketService } from "@/services/socketService";

function Layout() {
  useEffect(() => {
    socketService.connect();
    return () => {
      socketService.disconnect();
    };
  }, []);

  return <Outlet />;
}
```

---

## 3. Consuming Events in Components

Any component can subscribe to events. Always **clean up** in the useEffect return.

### Example: News Feed (subscribes to `rss_update`)

```typescript
import { useEffect } from "react";
import { socketService } from "@/services/socketService";

function NewsFeed() {
  useEffect(() => {
    const handleConnectionStatus = (data: unknown) => {
      const { isConnected } = data as { isConnected: boolean };
      // Update your state/store
    };

    const handleRssUpdate = (data: unknown) => {
      // Process incoming RSS item, dispatch to store, show notification, etc.
    };

    socketService.on("connection_status", handleConnectionStatus);
    socketService.on("rss_update", handleRssUpdate);

    // Check initial status
    const isConnected = socketService.getConnectionStatus();

    return () => {
      socketService.off("connection_status", handleConnectionStatus);
      socketService.off("rss_update", handleRssUpdate);
    };
  }, []);
}
```

### Example: SEC Filings (subscribes to `sec_filing_update` and `sec_analysis_update`)

```typescript
useEffect(() => {
  const handleSecFilingUpdate = (data: unknown) => {
    // Handle new SEC filing
  };

  const handleSecAnalysisComplete = (data: unknown) => {
    // Handle completed SEC analysis
  };

  socketService.on("sec_filing_update", handleSecFilingUpdate);
  socketService.on("sec_analysis_update", handleSecAnalysisComplete);

  return () => {
    socketService.off("sec_filing_update", handleSecFilingUpdate);
    socketService.off("sec_analysis_update", handleSecAnalysisComplete);
  };
}, []);
```

---

## 4. Available Events

| Event                  | Direction        | Description                                                                       |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `connection_status`    | Internal         | Fired when socket connects/disconnects. Payload: `{ connected: boolean, socketId?: string }` |
| `connection_error`     | Internal         | Fired on connection failure. Payload: `{ error: Error }`                          |
| `rss_update`           | Server → Client  | New RSS news item received                                                        |
| `sec_filing_update`    | Server → Client  | New SEC filing detected                                                           |
| `sec_analysis_update`  | Server → Client  | SEC analysis completed                                                            |

---

## 5. Configuration

| Setting        | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Server URL     | `https://rag-django-sq2f.onrender.com`                             |
| Transports     | `["websocket", "polling"]` (WebSocket preferred, falls back to polling) |
| Timeout        | `20000ms` (20 seconds)                                             |
| Socket.IO Path | `/socket.io`                                                       |

---

## 6. Key Design Decisions

- **Singleton pattern** — One shared instance ensures a single connection and avoids duplicate listeners.
- **Custom event bus on top of Socket.IO** — The `eventHandlers` map decouples components from the raw socket. Components subscribe/unsubscribe via `on()`/`off()` without touching the socket directly.
- **Cleanup is mandatory** — Every `on()` call in a `useEffect` must have a matching `off()` in the cleanup function to prevent memory leaks and duplicate handler calls.
- **Connect at root, consume anywhere** — The layout owns the connection; child components only listen.

---

## 7. Dependencies

```bash
npm install socket.io-client
```
