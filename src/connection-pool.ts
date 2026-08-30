export interface BrokerConnection {
  accountId: string;
  connected: boolean;
  lastActivity?: number;
}

export interface ConnectionHealth {
  accountId: string;
  connected: boolean;
  lastChecked: string;
  uptimePercent: number;
  lastError?: string;
}

export interface PoolOptions {
  connectionTTL?: number;
  maxConnections?: number;
}

export function createConnectionPool(options: PoolOptions = {}) {
  const connectionTTL = options.connectionTTL ?? 300000; // 5 minutes default
  const maxConnections = options.maxConnections ?? 100;

  const connections = new Map<string, BrokerConnection>();
  const health = new Map<string, ConnectionHealth>();
  let currentAccount: string | null = null;

  return {
    setConnection(accountId: string, connection: BrokerConnection): void {
      if (connections.size >= maxConnections && !connections.has(accountId)) {
        throw new Error(`Connection pool is full (max: ${maxConnections})`);
      }

      connections.set(accountId, connection);

      health.set(accountId, {
        accountId,
        connected: connection.connected,
        lastChecked: new Date().toISOString(),
        uptimePercent: connection.connected ? 100 : 0,
      });
    },

    getConnection(accountId: string): BrokerConnection | null {
      const conn = connections.get(accountId);
      if (!conn) return null;

      // Check if connection is stale
      const lastActivity = conn.lastActivity ?? Date.now();
      if (Date.now() - lastActivity > connectionTTL) {
        this.removeConnection(accountId);
        return null;
      }

      return conn;
    },

    getConnectionHealth(accountId: string): ConnectionHealth | null {
      return health.get(accountId) ?? null;
    },

    getCurrentAccount(): string | null {
      return currentAccount;
    },

    switchAccount(accountId: string): boolean {
      const conn = this.getConnection(accountId);
      if (!conn) return false;

      currentAccount = accountId;
      return true;
    },

    getConnectedAccounts(): string[] {
      return Array.from(connections.keys()).filter((accountId) => {
        const conn = connections.get(accountId);
        return conn?.connected ?? false;
      });
    },

    removeConnection(accountId: string): void {
      connections.delete(accountId);
      health.delete(accountId);

      if (currentAccount === accountId) {
        currentAccount = null;
      }
    },

    recordError(accountId: string, error: string): void {
      const h = health.get(accountId);
      if (h) {
        h.lastError = error;
        h.connected = false;
        h.lastChecked = new Date().toISOString();
      }

      const conn = connections.get(accountId);
      if (conn) {
        conn.connected = false;
      }
    },

    recordSuccess(accountId: string): void {
      const h = health.get(accountId);
      if (h) {
        h.connected = true;
        h.lastError = undefined;
        h.lastChecked = new Date().toISOString();
      }

      const conn = connections.get(accountId);
      if (conn) {
        conn.connected = true;
        conn.lastActivity = Date.now();
      }
    },

    getAllConnections(): BrokerConnection[] {
      return Array.from(connections.values());
    },

    getPoolStats() {
      return {
        totalConnections: connections.size,
        connectedCount: this.getConnectedAccounts().length,
        maxConnections,
        currentAccount,
      };
    },

    clear(): void {
      connections.clear();
      health.clear();
      currentAccount = null;
    },
  };
}
