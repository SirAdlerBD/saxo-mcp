/**
 * Trading wrappers (POST / PATCH / DELETE). Only reachable when
 * SAXO_TRADING=enabled; every call goes through SaxoClient's hard block.
 *
 * Request shapes follow Saxo's official openapi-samples-js "orders/stocks":
 *   POST   /trade/v2/orders/precheck   body: order + FieldGroups ["Costs","MarginImpactBuySell"]
 *   POST   /trade/v2/orders            body: { AccountKey, Uic, AssetType, BuySell, Amount, OrderType,
 *                                              OrderPrice?, StopLimitPrice?, OrderDuration:{DurationType,...},
 *                                              ManualOrder, ExternalReference? }
 *   PATCH  /trade/v2/orders            body: same fields + OrderId
 *   DELETE /trade/v2/orders/{OrderId}?AccountKey=...
 *
 * X-Request-ID: Saxo rejects an identical order re-submitted within 15 s with
 * 409 Conflict when this header is absent, and de-duplicates when present. We
 * always send a fresh random id per call so retries after a network error are
 * safe and identical-but-intentional orders are still accepted.
 */
import { randomUUID } from "node:crypto";
import type { SaxoClient } from "./client.js";

export type BuySell = "Buy" | "Sell";
export type OrderType = "Market" | "Limit" | "Stop" | "StopLimit" | "StopIfTraded" | "TrailingStop" | "TrailingStopIfTraded";
export type DurationType = "DayOrder" | "GoodTillCancel" | "GoodTillDate" | "ImmediateOrCancel" | "FillOrKill" | "AtTheOpening" | "AtTheClose";

export interface OrderDuration {
  DurationType: DurationType;
  /** Required for GoodTillDate, e.g. "2024-12-31T17:00:00". */
  ExpirationDateTime?: string;
  ExpirationDateContainsTime?: boolean;
}

export interface NewOrder {
  AccountKey: string;
  Uic: number;
  AssetType: string;
  BuySell: BuySell;
  Amount: number;
  OrderType: OrderType;
  OrderPrice?: number;
  StopLimitPrice?: number;
  TrailingstopDistanceToMarket?: number;
  TrailingStopStep?: number;
  OrderDuration: OrderDuration;
  /** true = a human decided this order; Saxo uses it for regulatory reporting. */
  ManualOrder: boolean;
  ExternalReference?: string;
}

export interface ModifyOrder extends Omit<NewOrder, "BuySell" | "ManualOrder"> {
  OrderId: string;
}

export class TradingApi {
  constructor(private readonly client: SaxoClient) {}

  get enabled(): boolean {
    return this.client.tradingEnabled;
  }

  /** Dry run: costs, margin impact and validation errors, without placing anything. */
  precheckOrder(order: NewOrder) {
    return this.client.post<Record<string, unknown>>(
      "/trade/v2/orders/precheck",
      { ...order, FieldGroups: ["Costs", "MarginImpactBuySell"] },
      { requestId: randomUUID() }
    );
  }

  placeOrder(order: NewOrder) {
    return this.client.post<Record<string, unknown>>("/trade/v2/orders", order, { requestId: randomUUID() });
  }

  modifyOrder(order: ModifyOrder) {
    return this.client.patch<Record<string, unknown>>("/trade/v2/orders", order, { requestId: randomUUID() });
  }

  cancelOrder(orderId: string, accountKey: string) {
    return this.client.delete<Record<string, unknown>>(
      `/trade/v2/orders/${encodeURIComponent(orderId)}`,
      { AccountKey: accountKey },
      { requestId: randomUUID() }
    );
  }
}
