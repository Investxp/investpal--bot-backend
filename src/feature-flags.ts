import { createHash } from 'crypto';

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  rolloutPercent?: number;
  allowedAccountTypes?: string[];
  disabledAccounts?: Set<string>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  timestamp: string;
  action: 'create' | 'enable' | 'disable' | 'update';
  details: string;
}

export interface FeatureStats {
  name: string;
  enabled: boolean;
  targetRolloutPercent?: number;
  affectedAccounts: number;
  createdAt: string;
}

export function createFeatureFlagService() {
  const flags = new Map<string, FeatureFlag>();
  const audit = new Map<string, AuditEntry[]>();

  function hashUserToPercentile(userId: string): number {
    const hash = createHash('sha256').update(userId).digest();
    return (hash.readUInt32BE(0) % 100) + 1;
  }

  return {
    createFlag(name: string, enabled: boolean): void {
      const flag: FeatureFlag = {
        name,
        enabled,
        disabledAccounts: new Set(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      flags.set(name, flag);

      if (!audit.has(name)) {
        audit.set(name, []);
      }
      audit.get(name)!.push({
        timestamp: new Date().toISOString(),
        action: 'create',
        details: `Flag created with enabled=${enabled}`,
      });
    },

    enable(name: string): void {
      const flag = flags.get(name);
      if (flag) {
        flag.enabled = true;
        flag.updatedAt = new Date().toISOString();
        audit.get(name)?.push({
          timestamp: new Date().toISOString(),
          action: 'enable',
          details: 'Flag enabled',
        });
      }
    },

    disable(name: string): void {
      const flag = flags.get(name);
      if (flag) {
        flag.enabled = false;
        flag.updatedAt = new Date().toISOString();
        audit.get(name)?.push({
          timestamp: new Date().toISOString(),
          action: 'disable',
          details: 'Flag disabled',
        });
      }
    },

    isEnabled(name: string): boolean {
      return flags.get(name)?.enabled ?? false;
    },

    isEnabledForAccount(accountId: string, name: string): boolean {
      const flag = flags.get(name);
      if (!flag || !flag.enabled) return false;

      if (flag.disabledAccounts?.has(accountId)) {
        return false;
      }

      return true;
    },

    disableForAccount(accountId: string, name: string): void {
      const flag = flags.get(name);
      if (flag) {
        flag.disabledAccounts?.add(accountId);
        audit.get(name)?.push({
          timestamp: new Date().toISOString(),
          action: 'update',
          details: `Flag disabled for account ${accountId}`,
        });
      }
    },

    enableForAccount(accountId: string, name: string): void {
      const flag = flags.get(name);
      if (flag) {
        flag.disabledAccounts?.delete(accountId);
      }
    },

    restrictByAccountType(name: string, accountTypes: string[]): void {
      const flag = flags.get(name);
      if (flag) {
        flag.allowedAccountTypes = accountTypes;
        audit.get(name)?.push({
          timestamp: new Date().toISOString(),
          action: 'update',
          details: `Restricted to account types: ${accountTypes.join(', ')}`,
        });
      }
    },

    isEnabledForAccountType(accountType: string, name: string): boolean {
      const flag = flags.get(name);
      if (!flag || !flag.enabled) return false;

      if (flag.allowedAccountTypes && !flag.allowedAccountTypes.includes(accountType)) {
        return false;
      }

      return true;
    },

    setRolloutPercentage(name: string, percent: number): void {
      const flag = flags.get(name);
      if (flag) {
        flag.rolloutPercent = Math.max(0, Math.min(100, percent));
        audit.get(name)?.push({
          timestamp: new Date().toISOString(),
          action: 'update',
          details: `Rollout percentage set to ${percent}%`,
        });
      }
    },

    isEnabledForUser(userId: string, name: string): boolean {
      const flag = flags.get(name);
      if (!flag || !flag.enabled) return false;

      if (flag.rolloutPercent === undefined) return true;

      const userPercentile = hashUserToPercentile(userId);
      return userPercentile <= flag.rolloutPercent;
    },

    getAuditLog(name: string): AuditEntry[] {
      return [...(audit.get(name) ?? [])];
    },

    getAllFlags(): FeatureFlag[] {
      return Array.from(flags.values());
    },

    getFeatureStats(name: string): FeatureStats | null {
      const flag = flags.get(name);
      if (!flag) return null;

      return {
        name: flag.name,
        enabled: flag.enabled,
        targetRolloutPercent: flag.rolloutPercent,
        affectedAccounts: flag.disabledAccounts?.size ?? 0,
        createdAt: flag.createdAt,
      };
    },

    clear(): void {
      flags.clear();
      audit.clear();
    },
  };
}
