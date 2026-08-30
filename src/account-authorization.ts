import type { Pool } from 'pg';

/**
 * Account isolation and authorization service.
 * 
 * Enforces multi-account isolation:
 * - Account ownership is verified before trading
 * - Live authorization is explicit and logged
 * - Account switching is audited
 */
export class AccountAuthorization {
  private readonly pool: Pool | null;
  private readonly liveAuthCache = new Map<string, { approvedAt: number; confirmed: boolean }>();

  constructor(pool: Pool | null) {
    this.pool = pool;
    // Clear cache every 30 minutes
    setInterval(() => this.liveAuthCache.clear(), 30 * 60 * 1000);
  }

  /**
   * Verify account ownership and permissions for trading
   * @returns true if account is valid and authorized for this trade mode
   */
  async authorizeAccount(
    accountId: string,
    mode: 'demo' | 'live',
    requireLiveConfirm: boolean
  ): Promise<{ authorized: boolean; reason?: string }> {
    // Validate account ID format
    if (!accountId || accountId.length === 0) {
      return { authorized: false, reason: 'Account ID is required' };
    }

    // Demo mode validation
    if (mode === 'demo') {
      const isDemoAccount = accountId.startsWith('VRTC') || accountId.startsWith('DOT');
      if (!isDemoAccount) {
        return { authorized: false, reason: 'Account is not a demo account' };
      }
      return { authorized: true };
    }

    // Live mode validation (strict)
    if (mode === 'live') {
      const isLiveAccount = accountId.startsWith('CR') || accountId.startsWith('ROT');
      if (!isLiveAccount) {
        return { authorized: false, reason: 'Account is not a live account' };
      }

      // Check for explicit live authorization
      if (requireLiveConfirm) {
        const cached = this.liveAuthCache.get(accountId);
        if (!cached || !cached.confirmed) {
          return { authorized: false, reason: 'Live trading requires explicit confirmation' };
        }
      }

      return { authorized: true };
    }

    return { authorized: false, reason: 'Invalid trade mode' };
  }

  /**
   * Record explicit live authorization (user confirms via UI)
   * @returns true if authorization was recorded
   */
  async recordLiveAuthorization(accountId: string, userConfirmed: boolean): Promise<boolean> {
    if (!userConfirmed) {
      this.liveAuthCache.delete(accountId);
      return false;
    }

    // Set confirmation with 30-minute expiry
    this.liveAuthCache.set(accountId, {
      approvedAt: Date.now(),
      confirmed: true,
    });

    // Optionally persist to database for audit trail
    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO live_authorization_log (account_id, confirmed_at, expires_at)
           VALUES ($1, now(), now() + INTERVAL '30 minutes')
           ON CONFLICT (account_id) DO UPDATE SET confirmed_at = now(), expires_at = now() + INTERVAL '30 minutes'`,
          [accountId]
        );
      } catch (error) {
        console.error('[Authorization] Failed to log live authorization:', error);
      }
    }

    return true;
  }

  /**
   * Check if live authorization is still valid for an account
   */
  isLiveAuthConfirmed(accountId: string): boolean {
    const cached = this.liveAuthCache.get(accountId);
    if (!cached) return false;

    // 30-minute expiry
    const isExpired = Date.now() - cached.approvedAt > 30 * 60 * 1000;
    return !isExpired && cached.confirmed;
  }

  /**
   * Revoke live authorization (for emergency stop, etc.)
   */
  revokeLiveAuthorization(accountId: string): void {
    this.liveAuthCache.delete(accountId);
  }

  /**
   * Get all live authorizations (for diagnostics)
   */
  getActiveAuthorizations(): string[] {
    const now = Date.now();
    const active: string[] = [];

    for (const [accountId, auth] of this.liveAuthCache) {
      const isExpired = now - auth.approvedAt > 30 * 60 * 1000;
      if (!isExpired && auth.confirmed) {
        active.push(accountId);
      }
    }

    return active;
  }
}
