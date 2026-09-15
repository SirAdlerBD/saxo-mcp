/**
 * Reference data, quote and chart wrappers (all GET).
 *
 *   /ref/v1/instruments?Keywords&AssetTypes&ExchangeId&AccountKey&$top
 *   /ref/v1/instruments/details/{Uic}/{AssetType}?AccountKey
 *   /ref/v1/instruments/tradingschedule/{Uic}/{AssetType}
 *   /trade/v1/infoprices?Uic&AssetType&AccountKey&FieldGroups   (GET, informational quote only)
 *   /chart/v3/charts?Uic&AssetType&Horizon&Count&Time&Mode&FieldGroups
 */
import type { SaxoClient } from "./client.js";
import type { ListResponse } from "./portfolio.js";

export const CHART_HORIZONS = [1, 5, 10, 15, 30, 60, 120, 240, 360, 480, 1440, 10080, 43200] as const;
export type ChartHorizon = (typeof CHART_HORIZONS)[number];

export const INFOPRICE_FIELD_GROUPS =
  "DisplayAndFormat,Quote,PriceInfo,PriceInfoDetails,InstrumentPriceDetails,HistoricalChanges";
export const CHART_FIELD_GROUPS = "ChartInfo,Data,DisplayAndFormat";

export class MarketDataApi {
  constructor(private readonly client: SaxoClient) {}

  searchInstruments(p: { keywords: string; assetTypes?: string; exchangeId?: string; accountKey?: string; top?: number; includeNonTradable?: boolean }) {
    return this.client.get<ListResponse<Record<string, unknown>>>("/ref/v1/instruments", {
      Keywords: p.keywords,
      AssetTypes: p.assetTypes,
      ExchangeId: p.exchangeId,
      AccountKey: p.accountKey,
      IncludeNonTradable: p.includeNonTradable ? "true" : undefined,
      $top: p.top ?? 20,
    });
  }

  instrumentDetails(uic: number, assetType: string, accountKey?: string) {
    return this.client.get<Record<string, unknown>>(
      `/ref/v1/instruments/details/${encodeURIComponent(uic)}/${encodeURIComponent(assetType)}`,
      { AccountKey: accountKey }
    );
  }

  tradingSchedule(uic: number, assetType: string) {
    return this.client.get<Record<string, unknown>>(
      `/ref/v1/instruments/tradingschedule/${encodeURIComponent(uic)}/${encodeURIComponent(assetType)}`
    );
  }

  /** Informational quote (bid/ask/mid, day high/low, last traded...). Never creates an order. */
  infoPrice(uic: number, assetType: string, accountKey?: string) {
    return this.client.get<Record<string, unknown>>("/trade/v1/infoprices", {
      Uic: uic,
      AssetType: assetType,
      AccountKey: accountKey,
      FieldGroups: INFOPRICE_FIELD_GROUPS,
    });
  }

  chart(p: { uic: number; assetType: string; horizon: ChartHorizon; count?: number; time?: string; mode?: "From" | "UpTo" }) {
    return this.client.get<{ Data: Record<string, unknown>[]; ChartInfo?: unknown; DisplayAndFormat?: unknown }>(
      "/chart/v3/charts",
      {
        Uic: p.uic,
        AssetType: p.assetType,
        Horizon: p.horizon,
        Count: p.count,
        Time: p.time,
        Mode: p.time ? (p.mode ?? "UpTo") : undefined,
        FieldGroups: CHART_FIELD_GROUPS,
      }
    );
  }
}
