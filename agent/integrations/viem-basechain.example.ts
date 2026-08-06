import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

/** Minimal ABIs — only what the agent calls. */
export const positionVaultAbi = [
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "adapter", type: "address" },
          { name: "pool", type: "address" },
          { name: "token", type: "address" },
          { name: "shares", type: "uint256" },
          {
            name: "params",
            type: "tuple",
            components: [
              { name: "rangeWidthBps", type: "uint16" },
              { name: "rebalanceDelay", type: "uint32" },
              { name: "autoCompound", type: "bool" },
            ],
          },
          { name: "rewardPref", type: "uint8" },
          { name: "zcashAddress", type: "string" },
          { name: "createdAt", type: "uint64" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "openFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "adapter", type: "address" },
      { name: "pool", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "rangeWidthBps", type: "uint16" },
          { name: "rebalanceDelay", type: "uint32" },
          { name: "autoCompound", type: "bool" },
        ],
      },
      { name: "rewardPref", type: "uint8" },
      { name: "zcashAddress", type: "string" },
    ],
    outputs: [{ name: "positionId", type: "uint256" }],
  },
] as const;

export const rewardRouterAbi = [
  {
    type: "function",
    name: "compound",
    stateMutability: "nonpayable",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "compoundedAmount", type: "uint256" },
      { name: "sharesAdded", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "routeToZcash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "intentsDepositAddress", type: "address" },
      { name: "quoteHash", type: "bytes32" },
    ],
    outputs: [{ name: "routedAmount", type: "uint256" }],
  },
] as const;

export const lpAdapterAbi = [
  {
    type: "function",
    name: "pendingRewards",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "inRange",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface OnchainPosition {
  owner: Address;
  adapter: Address;
  pool: Address;
  token: Address;
  shares: bigint;
  params: { rangeWidthBps: number; rebalanceDelay: number; autoCompound: boolean };
  rewardPref: number; // 0 = COMPOUND, 1 = SEND_TO_ZCASH
  zcashAddress: string;
  createdAt: bigint;
  active: boolean;
}

/**
 * Thin viem wrapper for everything the agent does on Base.
 * All addresses come from config; nothing is hardcoded so the same code runs
 * against Base mainnet, Base Sepolia, or a local anvil fork.
 */
export class BaseChainService {
  readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly account?: Account;

  constructor(
    rpcUrl: string,
    private readonly vaultAddress: Address,
    private readonly routerAddress: Address,
    operatorPrivateKey?: Hex,
    chain: Chain = base
  ) {
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    if (operatorPrivateKey) {
      this.account = privateKeyToAccount(operatorPrivateKey);
      this.walletClient = createWalletClient({
        chain,
        transport: http(rpcUrl),
        account: this.account,
      });
    }
  }

  async getPosition(positionId: bigint): Promise<OnchainPosition> {
    const p = (await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: positionVaultAbi,
      functionName: "getPosition",
      args: [positionId],
    })) as unknown as OnchainPosition;
    return p;
  }

  async getPendingRewards(adapter: Address, positionId: bigint) {
    const [tokens, amounts] = (await this.publicClient.readContract({
      address: adapter,
      abi: lpAdapterAbi,
      functionName: "pendingRewards",
      args: [positionId],
    })) as [Address[], bigint[]];
    return { tokens, amounts };
  }

  async isInRange(adapter: Address, positionId: bigint): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: adapter,
      abi: lpAdapterAbi,
      functionName: "inRange",
      args: [positionId],
    })) as boolean;
  }

  async compound(positionId: bigint): Promise<Hex> {
    return this.write(this.routerAddress, rewardRouterAbi, "compound", [positionId]);
  }

  async routeToZcash(
    positionId: bigint,
    intentsDepositAddress: Address,
    quoteHash: Hex
  ): Promise<Hex> {
    return this.write(this.routerAddress, rewardRouterAbi, "routeToZcash", [
      positionId,
      intentsDepositAddress,
      quoteHash,
    ]);
  }

  async estimateGasUsd(gasUnits: bigint, ethUsd: number): Promise<number> {
    const gasPrice = await this.publicClient.getGasPrice();
    return (Number(gasUnits * gasPrice) / 1e18) * ethUsd;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async write(address: Address, abi: any, functionName: string, args: unknown[]) {
    if (!this.walletClient || !this.account) {
      throw new Error("No operator key configured — agent is in read-only mode.");
    }
    const { request } = await this.publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: this.account,
    } as never);
    return this.walletClient.writeContract(request as never);
  }
}
