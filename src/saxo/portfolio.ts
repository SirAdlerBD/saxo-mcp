/**
 * Portfolio service group wrappers (all GET).
 *
 * Paths taken from Saxo's official openapi-samples-js repository and the
 * developer portal reference docs:
 *   /port/v1/users/me, /port/v1/clients/me, /port/v1/accounts/me
 *   /port/v1/balances?ClientKey&AccountKey
 *   /port/v1/positions?ClientKey&AccountKey&FieldGroups
 *   /port/v1/netpositions?ClientKey&AccountKey&FieldGroups
 *   /port/v1/orders?ClientKey&AccountKey&Status&FieldGroups
 *   /hist/v4/performance/summary|timeseries?ClientKey&AccountKey&StandardPeriod|FromDate&ToDate&FieldGroups
 *   /cs/v1/reports/trades/{ClientKey}, /cs/v1/reports/bookings/{ClientKey}
 *   /cs/v1/audit/orderactivities?ClientKey...
 */
import type { SaxoClient } from "./client.js";

export interface ClientInfo {
  ClientKey: string;
  ClientId?: string;
  Name?: string;
  DefaultAccountKey: string;
  DefaultAccountId?: string;
  DefaultCurrency?: string;
  PositionNettingMode?: string;
  [key: string]: unknown;
}

export interface AccountInfo {
  AccountKey: string;
  AccountId?: string;
  Currency?: string;
  AccountType?: string;
  Active?: boolean;
  DisplayName?: string;
  [key: string]: unknown;
}

export interface ListResponse<T> {
  Data: T[];
  __count?: number;
  __next?: string;
}

/**
 * Most Saxo portfolio endpoints need a ClientKey and usually an AccountKey.
 * These are stable identifiers for the logged-in user, so we fetch them once
 * per process and cache them.
 */
export class AccountContext {
  private clientPromise: Promise<ClientInfo> | null = null;

  constructor(private readonly client: SaxoClient) {}

  getClient(): Promise<ClientInfo> {
    if (!this.clientPromise) {
      this.clientPromise = this.client.get<ClientInfo>("/port/v1/clients/me").catch((err) => {
        this.clientPromise = null; // do not cache failures
        throw err;
      });
    }
    return this.clientPromise;
  }

  async keys(accountKey?: string): Promise<{ clientKey: string; accountKey: string }> {
    const c = await this.getClient();
    return { clientKey: c.ClientKey, accountKey: accountKey ?? c.DefaultAccountKey };
  }
}

export const POSITION_FIELD_GROUPS = "PositionBase,PositionView,DisplayAndFormat,ExchangeInfo";
export const NET_POSITION_FIELD_GROUPS = "NetPositionBase,NetPositionView,DisplayAndFormat,ExchangeInfo";
export const ORDER_FIELD_GROUPS = "DisplayAndFormat,ExchangeInfo";

export type StandardPeriod = "Month" | "Quarter" | "Year" | "AllTime";

export interface DateRange {
  standardPeriod?: StandardPeriod;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string; // YYYY-MM-DD
}

export function dateRangeQuery(r: DateRange): Record<string, string | undefined> {
  if (r.standardPeriod) return { StandardPeriod: r.standardPeriod };
  return { FromDate: r.fromDate, ToDate: r.toDate };
}

export class PortfolioApi {
  readonly context: AccountContext;

  constructor(private readonly client: SaxoClient) {
    this.context = new AccountContext(client);
  }

  user() {
    return this.client.get<Record<string, unknown>>("/port/v1/users/me");
  }

  clientInfo() {
    return this.context.getClient();
  }

  accounts() {
    return this.client.get<ListResponse<AccountInfo>>("/port/v1/accounts/me");
  }

  async balances(accountKey?: string, wholeClient = false) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<Record<string, unknown>>("/port/v1/balances", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
    });
  }

  async positions(accountKey?: string, wholeClient = false) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<ListResponse<Record<string, unknown>>>("/port/v1/positions", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
      FieldGroups: POSITION_FIELD_GROUPS,
    });
  }

  async netPositions(accountKey?: string, wholeClient = false) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<ListResponse<Record<string, unknown>>>("/port/v1/netpositions", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
      FieldGroups: NET_POSITION_FIELD_GROUPS,
    });
  }

  /** LIST open/working orders. Viewing only; there is no way to place or change orders here. */
  async openOrders(accountKey?: string, wholeClient = false) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<ListResponse<Record<string, unknown>>>("/port/v1/orders", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
      Status: "All",
      FieldGroups: ORDER_FIELD_GROUPS,
    });
  }

  async performanceSummary(range: DateRange, accountKey?: string, wholeClient = false, fieldGroups = "All") {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<Record<string, unknown>>("/hist/v4/performance/summary", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
      FieldGroups: fieldGroups,
      ...dateRangeQuery(range),
    });
  }

  async performanceTimeseries(range: DateRange, accountKey?: string, wholeClient = false, fieldGroups = "All") {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<Record<string, unknown>>("/hist/v4/performance/timeseries", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
      FieldGroups: fieldGroups,
      ...dateRangeQuery(range),
    });
  }

  /** Executed trades report. */
  async tradesReport(fromDate: string, toDate: string, accountKey?: string, wholeClient = false, top = 200) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<ListResponse<Record<string, unknown>>>(
      `/cs/v1/reports/trades/${encodeURIComponent(clientKey)}`,
      { FromDate: fromDate, ToDate: toDate, AccountKey: wholeClient ? undefined : ak, $top: top }
    );
  }

  /** Cash bookings (deposits, withdrawals, fees, dividends, settlements...). */
  async bookingsReport(fromDate: string, toDate: string, accountKey?: string, wholeClient = false, top = 200) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<ListResponse<Record<string, unknown>>>(
      `/cs/v1/reports/bookings/${encodeURIComponent(clientKey)}`,
      { FromDate: fromDate, ToDate: toDate, AccountKey: wholeClient ? undefined : ak, $top: top }
    );
  }

  /** Order activity audit log (placed / filled / cancelled events). Read-only audit trail. */
  async orderActivities(fromDate: string, toDate: string, accountKey?: string, wholeClient = false, top = 200) {
    const { clientKey, accountKey: ak } = await this.context.keys(accountKey);
    return this.client.get<ListResponse<Record<string, unknown>>>("/cs/v1/audit/orderactivities", {
      ClientKey: clientKey,
      AccountKey: wholeClient ? undefined : ak,
      FromDateTime: `${fromDate}T00:00:00Z`,
      ToDateTime: `${toDate}T23:59:59Z`,
      FieldGroups: "DisplayAndFormat",
      IncludeSubAccounts: false,
      $top: top,
    });
  }
}
