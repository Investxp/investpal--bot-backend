import { v4 as uuid } from 'uuid';

export interface PaperContract {
  contractId: number;
  executionId: string;
  symbol: string;
  contractType: string;
  stake: number;
  status: 'open' | 'won' | 'lost' | 'cancelled';
  profit: number;
  createdAt: string;
}

export class PaperExecutionAdapter {
  private nextContractId = 1;
  private readonly contracts = new Map<number, PaperContract>();

  place(executionId: string, symbol: string, contractType: string, stake: number): PaperContract {
    if (!executionId || !symbol || !contractType || !Number.isFinite(stake) || stake <= 0) throw new Error('Invalid paper execution request');
    const contract: PaperContract = {
      contractId: this.nextContractId++, executionId, symbol, contractType, stake,
      status: 'open', profit: 0, createdAt: new Date().toISOString(),
    };
    this.contracts.set(contract.contractId, contract);
    return { ...contract };
  }

  settle(contractId: number, won: boolean, payout = 0): PaperContract {
    const contract = this.contracts.get(contractId);
    if (!contract) throw new Error('Paper contract not found');
    if (contract.status !== 'open') throw new Error('Paper contract is already settled');
    contract.status = won ? 'won' : 'lost';
    contract.profit = won ? Math.max(0, payout - contract.stake) : -contract.stake;
    return { ...contract };
  }

  get(contractId: number): PaperContract | null { return this.contracts.has(contractId) ? { ...this.contracts.get(contractId)! } : null; }
  list(): PaperContract[] { return [...this.contracts.values()].map(contract => ({ ...contract })); }
}

export function createPaperExecutionId(): string { return uuid(); }
