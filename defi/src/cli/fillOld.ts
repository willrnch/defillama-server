require("dotenv").config();
const protocolToRefill = "Uniswap"
const latestDate = undefined; // undefined -> start from today, number => start from that unix timestamp
const batchSize = 1; // how many days to fill in parallel

import dynamodb from "../utils/shared/dynamodb";
import { getProtocol, getBlocksRetry } from "./utils";
import {
  dailyTokensTvl,
  dailyTvl,
  dailyUsdTokensTvl,
} from "../utils/getLastRecord";
import { getClosestDayStartTimestamp } from "../utils/date";
import { storeTvl } from "../storeTvlInterval/getAndStoreTvl";
import {
  getCoingeckoLock,
  releaseCoingeckoLock,
} from "../utils/shared/coingeckoLocks";
import type { Protocol } from "../protocols/data";
import { DocumentClient } from "aws-sdk/clients/dynamodb";

const secondsInDay = 24 * 3600;

type DailyItems = (DocumentClient.ItemList | undefined)[];
async function deleteItemsOnSameDay(dailyItems: DailyItems, timestamp: number) {
  for (const items of dailyItems) {
    const itemsOnSameDay =
      items?.filter(
        (item) => getClosestDayStartTimestamp(item.SK) === timestamp
      ) ?? [];
    for (const item of itemsOnSameDay) {
      await dynamodb.delete({
        Key: {
          PK: item.PK,
          SK: item.SK,
        },
      });
    }
  }
}

async function getAndStore(
  timestamp: number,
  protocol: Protocol,
  dailyItems: DailyItems
) {
  const { ethereumBlock, chainBlocks } = await getBlocksRetry(timestamp);
  const tvl = await storeTvl(
    timestamp,
    ethereumBlock,
    chainBlocks,
    protocol,
    {},
    4,
    getCoingeckoLock,
    false,
    false,
    true,
    () => deleteItemsOnSameDay(dailyItems, timestamp)
  );
  console.log(timestamp, new Date(timestamp * 1000).toDateString(), tvl);
}

function getDailyItems(pk: string) {
  return dynamodb
    .query({
      ExpressionAttributeValues: {
        ":pk": pk,
      },
      KeyConditionExpression: "PK = :pk",
    })
    .then((res) => res.Items);
}

const main = async () => {
  const protocol = getProtocol(protocolToRefill);
  const adapter = await import(
    `../../DefiLlama-Adapters/projects/${protocol.module}`
  );
  if (adapter.timetravel === false) {
    throw new Error("Adapter doesn't support refilling");
  }
  const dailyTvls = await getDailyItems(dailyTvl(protocol.id));
  const dailyTokens = await getDailyItems(dailyTokensTvl(protocol.id));
  const dailyUsdTokens = await getDailyItems(dailyUsdTokensTvl(protocol.id));
  const dailyItems = [dailyTvls, dailyTokens, dailyUsdTokens];
  const start = adapter.start ?? 0;
  const now = Math.round(Date.now() / 1000);
  let timestamp = getClosestDayStartTimestamp(latestDate ?? now);
  if (timestamp > now) {
    timestamp = getClosestDayStartTimestamp(timestamp - secondsInDay);
  }
  setInterval(() => {
    releaseCoingeckoLock();
  }, 1.5e3);
  while (timestamp > start) {
    const batchedActions = [];
    for (let i = 0; i < batchSize && timestamp > start; i++) {
      batchedActions.push(getAndStore(timestamp, protocol, dailyItems));
      timestamp = getClosestDayStartTimestamp(timestamp - secondsInDay);
    }
    await Promise.all(batchedActions);
  }
};
main();
