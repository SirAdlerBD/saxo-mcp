/**
 * Helpers shared by all tools: uniform JSON results and error mapping.
 *
 * Every tool returns its data as pretty-printed JSON text (the model reads it
 * as-is). Errors are returned as MCP tool errors (`isError: true`) with a
 * human-readable message, never thrown, so the assistant can relay them
 * instead of the server crashing. Auth problems get an explicit "run
 * `npm run login`" instruction.
 */
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuthRequiredError } from "../auth/tokenManager.js";
import { ReadOnlyViolationError, SaxoApiError, TradingDisabledError } from "../saxo/client.js";

/** Advertise to MCP clients that these tools never modify anything. */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof AuthRequiredError) {
    text = `AUTHENTICATION REQUIRED: ${err.message}`;
  } else if (err instanceof SaxoApiError) {
    text = `Saxo API error: ${err.message}`;
    if (err.details && typeof err.details === "object") {
      text += `\nDetails: ${JSON.stringify(err.details).slice(0, 800)}`;
    }
  } else if (err instanceof TradingDisabledError || err instanceof ReadOnlyViolationError) {
    text = err.message;
  } else if (err instanceof Error) {
    text = `Error: ${err.message}`;
  } else {
    text = `Error: ${String(err)}`;
  }
  console.error(`[saxo-mcp] tool error: ${text.split("\n")[0]}`);
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wrap a tool body so any exception becomes a structured error result. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format");

export const accountKeyParam = z
  .string()
  .optional()
  .describe("Saxo AccountKey. Omit to use the client's default account (see get_account_summary for the list).");

export const wholeClientParam = z
  .boolean()
  .optional()
  .describe("If true, aggregate across ALL accounts of the client instead of one account.");

export const assetTypeParam = z
  .string()
  .describe('Saxo AssetType exactly as returned by search_instruments, e.g. "Stock", "FxSpot", "Etf", "CfdOnStock", "ContractFutures".');

export const uicParam = z.number().int().positive().describe("Saxo UIC (universal instrument code) from search_instruments.");

/** Default date window for history tools when the caller gives none: last 30 days. */
export function defaultRange(days = 30): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { fromDate: fmt(from), toDate: fmt(to) };
}
