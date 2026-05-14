import { io, Socket } from 'socket.io-client';

const SOCKET_URL = 'https://rag-django-sq2f.onrender.com';

type EventHandler = (data: unknown) => void;

class SocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private eventHandlers: Map<string, EventHandler[]> = new Map();

  connect() {
    if (this.socket?.connected) return this.socket;

    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      path: '/socket.io',
      reconnectionAttempts: 5,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 15000,
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.notifyHandlers('connection_status', { connected: true, socketId: this.socket?.id });
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
      this.notifyHandlers('connection_status', { connected: false });
    });

    this.socket.on('connect_error', () => {
      this.notifyHandlers('connection_error', { error: 'Connection failed' });
    });

    this.socket.io.on('reconnect_failed', () => {
      console.warn('[Socket] Max reconnection attempts reached — giving up');
      this.notifyHandlers('connection_status', { connected: false });
    });

    this.socket.on('rss_update', (data: unknown) => this.notifyHandlers('rss_update', data));
    this.socket.on('sec_filing_update', (data: unknown) => this.notifyHandlers('sec_filing_update', data));
    this.socket.on('sec_analysis_update', (data: unknown) => this.notifyHandlers('sec_analysis_update', data));

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

  on(event: string, handler: EventHandler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event)!.push(handler);
  }

  off(event: string, handler: EventHandler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx > -1) handlers.splice(idx, 1);
    }
  }

  private notifyHandlers(event: string, data: unknown) {
    this.eventHandlers.get(event)?.forEach((h) => h(data));
  }

  getConnectionStatus() {
    return this.isConnected;
  }
}

export const socketService = new SocketService();
