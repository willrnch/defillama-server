import { wrap, IResponse, errorResponse } from "./utils/shared";
import { storeDataset } from "./utils/s3";
import { getChainDisplayName, chainCoingeckoIds, transformNewChainName } from "./utils/normalizeChain";
import { getHistoricalTvlForAllProtocols } from './storeGetCharts'
import { formatTimestampAsDate, getClosestDayStartTimestamp, secondsInHour } from "./utils/date";

const handler = async (
  event: AWSLambda.APIGatewayEvent
): Promise<IResponse> => {
  const rawChain = event.pathParameters!.chain!;
  const globalChain = rawChain === "All" ? null : getChainDisplayName(rawChain, true)
  const params = event.queryStringParameters ?? {};

  const sumDailyTvls = {} as {
    [ts: number]: {
      [protocol: string]: number
    }
  }

  const { historicalProtocolTvls, lastDailyTimestamp } = await getHistoricalTvlForAllProtocols();
  historicalProtocolTvls.forEach((protocolTvl) => {
    if (protocolTvl === undefined) {
      return;
    }
    let { historicalTvl, protocol, lastTimestamp } = protocolTvl;
    const lastTvl = historicalTvl[historicalTvl.length - 1];
    while (lastTimestamp < lastDailyTimestamp) {
      lastTimestamp = getClosestDayStartTimestamp(lastTimestamp + 24 * secondsInHour)
      historicalTvl.push({
        ...lastTvl,
        SK: lastTimestamp,
      });
    }
    historicalTvl.forEach((item) => {
      let chainToBeUsed = globalChain;
      const itemHasChains = Object.keys(item).some(chain=>chainCoingeckoIds[getChainDisplayName(chain, true)] !== undefined)
      if(!itemHasChains && transformNewChainName(protocol.chain) === globalChain){
        chainToBeUsed = null
      }
      const prefix = chainToBeUsed === null ? "" : `${chainToBeUsed}-`;
      let dayTvl = 0;
      Object.entries(item).forEach(([chain, tvl]) => {
        const chainName = getChainDisplayName(chain, true);
        if(chainName.startsWith(prefix)){
          const sectionName = chainName.slice(prefix.length)
          if(params[sectionName] === "true"){
            dayTvl += tvl;
            return
          }
        }
        if((chainToBeUsed === null && chain === "tvl") || chainToBeUsed === chainName){
          dayTvl += tvl;
        }
      })
      if (dayTvl !== 0) {
        const timestamp = getClosestDayStartTimestamp(item.SK);
        if (sumDailyTvls[timestamp] === undefined) { sumDailyTvls[timestamp] = {} }
        if (sumDailyTvls[timestamp]!.Total === undefined) { sumDailyTvls[timestamp].Total = 0 }
        sumDailyTvls[timestamp][protocol.name] = dayTvl;
        sumDailyTvls[timestamp].Total += dayTvl;
      }
    });
  });

  const timestamps = Object.keys(sumDailyTvls).sort()
  const grid = [["Protocol", ...timestamps.map(t=>formatTimestampAsDate(t))]]
  let lastRow = 1;
  const protocolToRow = {
    'Total': lastRow
  } as {[protocol:string]:number}
  grid[1]=["Total"]
  timestamps.forEach((t, i)=>{
    Object.entries(sumDailyTvls[Number(t)]).forEach(([protocol, tvl])=>{
      let row = protocolToRow[protocol]
      if(row === undefined){
        row = ++lastRow;
        protocolToRow[protocol]=lastRow;
        grid[lastRow]=[protocol];
      }
      grid[row][i+1]=String(tvl)
    })
  })
  if(grid.length<=2){
    return errorResponse({message: "No chain with that name exists"})
  }
  const csv = grid.map(r=>r.join(',')).join('\n')
  const filename = `chain-dataset-${rawChain}.csv`
  await storeDataset(filename, csv)

  const response: IResponse = {
    statusCode: 307,
    body: "",
    headers: {
      "Location": `https://defillama-datasets.s3.eu-central-1.amazonaws.com/temp/${filename}`,
    },
  };
  return response;
};

export default wrap(handler);
