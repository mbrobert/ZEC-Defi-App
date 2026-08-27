/**
 * Engine event topics + decoders — the ground truth of the empirical pipeline.
 *
 * PROVENANCE (dual-verified 2026-08-27):
 *  1. Signatures read from the engine implementation's VERIFIED source ABI —
 *     SnuggleVaultUpgradeable at 0x359f90ee4c2e21cbf6e32c5a062eeef306822d28
 *     (behind proxy 0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55), fetched
 *     from base.blockscout.com (is_verified: true, 33 events).
 *  2. topic0 hashes computed with the test-verified vendored keccak AND
 *     matched 1:1 against a live eth_getLogs sweep of the vault (blocks
 *     50532373–50534372): OutOfRangeStatusUpdated ×631, SnuggleRebalanced
 *     ×48, PerformanceFeeCollected ×44, FeesHarvested ×31, PositionCreated
 *     ×27, StakingRewardsClaimed ×18, PositionWithdrawn ×12.
 *
 * If a decode here ever disagrees with the chain, the chain is right —
 * re-run the verification recipe in docs/YIELD-SERVICE.md before shipping a
 * change.
 */

import {
  strip0x,
  topicToAddress,
  topicToBigint,
  word,
  wordToAddress,
  wordToBigint,
  wordToBool,
  wordToInt24,
} from "../abi.js";
import type { EngineEvent, Hex, RawLog } from "../types.js";

export const TOPICS = {
  /** PositionCreated(uint256 idx,address idx,bytes32 idx,int24,int24,uint128,bool) */
  PositionCreated:
    "0x122df793e932991c659ba0d9c044844fa40f9e9d8ef31c49a72f20eaf0731064",
  /** PositionWithdrawn(uint256 idx,address idx,uint256,uint256) */
  PositionWithdrawn:
    "0x6702331390e9cd89e5ceade4f59699abc69a77c043d3844e2835c56812a3d59f",
  /** FeesHarvested(uint256 idx,address idx,uint256,uint256) */
  FeesHarvested:
    "0x452b22f6ddf3d1109a8e3ffa961f0727935ebd4df8c6e922f5361aba654acec1",
  /** StakingRewardsClaimed(uint256 idx,address idx,address idx,uint256) */
  StakingRewardsClaimed:
    "0xe6d1ff392bdc1cf53105ebfcb0e3f7b024a8b0915b1f131907da7a9f84f52b86",
  /** PerformanceFeeCollected(uint256 idx,address idx,uint256,uint256,uint256) */
  PerformanceFeeCollected:
    "0x55ffbf9681080527dff42e69485eb3b96f061a1d0c61f43b4dfcc59263b5c5b0",
  /** SnuggleRebalanced(uint256 idx,uint256 idx,address idx,int24,int24,uint256,uint256,bool,uint32) */
  SnuggleRebalanced:
    "0x125c342de1fd6de2d82c27973075e1bf1f9764930449bc7eeae87efc59eadfaf",
} as const satisfies Record<string, Hex>;

/** The topics the indexer subscribes to (lifecycle + earnings + activity). */
export const INDEXED_TOPICS: Hex[] = [
  TOPICS.PositionCreated,
  TOPICS.PositionWithdrawn,
  TOPICS.FeesHarvested,
  TOPICS.StakingRewardsClaimed,
  TOPICS.PerformanceFeeCollected,
  TOPICS.SnuggleRebalanced,
];

/**
 * Decode one raw vault log into an EngineEvent, or null when the topic is
 * not one we index (Paused, ReferralPaid, keeper churn, …).
 */
export function decodeEngineLog(log: RawLog): EngineEvent | null {
  const t0 = log.topics[0];
  const base = {
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
  const data = strip0x(log.data);

  switch (t0) {
    case TOPICS.PositionCreated: {
      if (log.topics.length !== 4) return null;
      return {
        kind: "PositionCreated",
        ...base,
        tokenId: topicToBigint(log.topics[1]).toString(),
        owner: topicToAddress(log.topics[2]),
        poolId: log.topics[3],
        tickLower: wordToInt24(word(data, 0)),
        tickUpper: wordToInt24(word(data, 1)),
        liquidity: wordToBigint(word(data, 2)).toString(),
        staked: wordToBool(word(data, 3)),
      };
    }
    case TOPICS.PositionWithdrawn: {
      if (log.topics.length !== 3) return null;
      return {
        kind: "PositionWithdrawn",
        ...base,
        tokenId: topicToBigint(log.topics[1]).toString(),
        owner: topicToAddress(log.topics[2]),
        amount0: wordToBigint(word(data, 0)).toString(),
        amount1: wordToBigint(word(data, 1)).toString(),
      };
    }
    case TOPICS.FeesHarvested: {
      if (log.topics.length !== 3) return null;
      return {
        kind: "FeesHarvested",
        ...base,
        tokenId: topicToBigint(log.topics[1]).toString(),
        recipient: topicToAddress(log.topics[2]),
        amount0: wordToBigint(word(data, 0)).toString(),
        amount1: wordToBigint(word(data, 1)).toString(),
      };
    }
    case TOPICS.StakingRewardsClaimed: {
      if (log.topics.length !== 4) return null;
      return {
        kind: "StakingRewardsClaimed",
        ...base,
        tokenId: topicToBigint(log.topics[1]).toString(),
        recipient: topicToAddress(log.topics[2]),
        rewardToken: topicToAddress(log.topics[3]),
        amount: wordToBigint(word(data, 0)).toString(),
      };
    }
    case TOPICS.PerformanceFeeCollected: {
      if (log.topics.length !== 3) return null;
      return {
        kind: "PerformanceFeeCollected",
        ...base,
        tokenId: topicToBigint(log.topics[1]).toString(),
        token: topicToAddress(log.topics[2]),
        amountA: wordToBigint(word(data, 0)).toString(),
        amountB: wordToBigint(word(data, 1)).toString(),
        amountC: wordToBigint(word(data, 2)).toString(),
      };
    }
    case TOPICS.SnuggleRebalanced: {
      if (log.topics.length !== 4) return null;
      return {
        kind: "SnuggleRebalanced",
        ...base,
        tokenId: topicToBigint(log.topics[1]).toString(),
        newTokenId: topicToBigint(log.topics[2]).toString(),
        pool: topicToAddress(log.topics[3]),
        tickLower: wordToInt24(word(data, 0)),
        tickUpper: wordToInt24(word(data, 1)),
        amount0: wordToBigint(word(data, 2)).toString(),
        amount1: wordToBigint(word(data, 3)).toString(),
        flag: wordToBool(word(data, 4)),
        count: Number(wordToBigint(word(data, 5))),
      };
    }
    default:
      return null;
  }
}
