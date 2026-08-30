export type StrategyVersionStatus = 'draft' | 'active' | 'archived';

export type StrategyVersionRecord<TConfig = Record<string, unknown>> = {
  strategyId: string;
  version: string;
  config: TConfig;
  status: StrategyVersionStatus;
  createdAt: string;
  updatedAt: string;
};

export type StrategyVersionValidationResult = {
  valid: boolean;
  error?: string;
};

function parseVersion(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function compareVersions(a: string, b: string): number {
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLength; i += 1) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;
    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }

  return 0;
}

export function createStrategyVersion<TConfig = Record<string, unknown>>({
  strategyId,
  version,
  config,
  status,
  createdAt,
  updatedAt,
}: {
  strategyId: string;
  version: string;
  config: TConfig;
  status?: StrategyVersionStatus;
  createdAt?: string;
  updatedAt?: string;
}): StrategyVersionRecord<TConfig> {
  if (!strategyId) throw new Error('strategyId is required');
  if (!version || typeof version !== 'string') throw new Error('version is required');

  const now = new Date().toISOString();

  return {
    strategyId,
    version,
    config,
    status: status ?? 'draft',
    createdAt: createdAt ?? now,
    updatedAt: updatedAt ?? now,
  };
}

export function findLatestVersion<TConfig = Record<string, unknown>>(versions: StrategyVersionRecord<TConfig>[]): StrategyVersionRecord<TConfig> | null {
  if (!Array.isArray(versions) || versions.length === 0) return null;

  return [...versions].sort((a, b) => compareVersions(a.version, b.version)).at(-1) ?? null;
}

export function validateVersionChain<TConfig = Record<string, unknown>>(versions: StrategyVersionRecord<TConfig>[]): StrategyVersionValidationResult {
  if (!Array.isArray(versions) || versions.length === 0) {
    return { valid: false, error: 'No versions were provided for validation.' };
  }

  for (let i = 1; i < versions.length; i += 1) {
    const prev = versions[i - 1];
    const current = versions[i];
    if (compareVersions(prev.version, current.version) > 0) {
      return {
        valid: false,
        error: 'Version order is invalid; versions must increase monotonically in the provided sequence.',
      };
    }
  }

  return { valid: true };
}

export function rollbackStrategyToVersion<TConfig = Record<string, unknown>>({
  strategyId,
  currentVersion,
  currentConfig,
  versions,
  targetVersion,
}: {
  strategyId: string;
  currentVersion: string;
  currentConfig: TConfig;
  versions: StrategyVersionRecord<TConfig>[];
  targetVersion: string;
}): StrategyVersionRecord<TConfig> {
  if (!strategyId) throw new Error('strategyId is required');
  if (!targetVersion) throw new Error('targetVersion is required');

  const target = versions.find((item) => item.strategyId === strategyId && item.version === targetVersion);
  if (!target) {
    throw new Error(`Version ${targetVersion} was not found for strategy ${strategyId}`);
  }

  const validation = validateVersionChain(versions);
  if (!validation.valid) {
    throw new Error(validation.error || 'Version chain validation failed');
  }

  const effectiveConfig = target.config ?? currentConfig;
  return {
    ...target,
    status: 'active',
    updatedAt: new Date().toISOString(),
    config: effectiveConfig,
    version: target.version,
  };
}
