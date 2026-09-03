/**
 * Log redaction helpers shared by the agent and the yield service.
 *
 * RPC provider URLs routinely embed the API key in the path or query
 * (https://base-mainnet.g.alchemy.com/v2/KEY). Nothing beyond the HOST is
 * ever safe to log — use redactUrl for every URL that reaches a log line.
 */

/**
 * The host (and port, if any) of a URL — never the path, query, or
 * credentials. Returns "<invalid-url>" rather than echoing unparseable
 * input, since malformed input may still contain a secret.
 */
export function redactUrl(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}
