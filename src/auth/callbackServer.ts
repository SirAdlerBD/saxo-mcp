/**
 * Temporary local HTTP server that catches the OAuth redirect.
 *
 * After the user logs in at Saxo, the browser is sent to the registered
 * redirect URI (http://localhost:<port>/callback?code=...&state=...). Nothing
 * is normally listening there, so we start a throwaway server on that port for
 * the duration of the login, read `code` and `state` off the first matching
 * request, show the user a "you can close this tab" page, and shut down.
 */
import http from "node:http";

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerOptions {
  redirectUri: string;
  /** Expected `state`; a mismatch is treated as an attack/misconfiguration and rejected. */
  expectedState: string;
  /** Abort if no callback arrives within this many ms. */
  timeoutMs?: number;
}

const OK_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
<h2>Saxo login complete</h2><p>You can close this tab and return to the terminal.</p></body></html>`;

const ERR_HTML = (msg: string) => `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
<h2>Saxo login failed</h2><p>${msg}</p><p>Return to the terminal for details.</p></body></html>`;

export function waitForCallback(opts: CallbackServerOptions): Promise<CallbackResult> {
  const target = new URL(opts.redirectUri);
  const port = Number(target.port || 80);
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // close() only stops new connections; also drop keep-alive ones so the
      // port is really free and nothing can talk to this server afterwards.
      server.close();
      server.closeAllConnections();
      fn();
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${target.hostname}:${port}`);
      if (url.pathname !== target.pathname) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not the OAuth callback path.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error) {
        const desc = url.searchParams.get("error_description") ?? "";
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERR_HTML(`${error} ${desc}`.trim()));
        finish(() => reject(new Error(`Saxo returned an OAuth error: ${error} ${desc}`.trim())));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERR_HTML("Missing code or state."));
        return; // keep listening; this may just be a stray request
      }
      if (state !== opts.expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERR_HTML("State mismatch."));
        finish(() => reject(new Error("OAuth state mismatch: the callback did not belong to this login attempt.")));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(OK_HTML);
      finish(() => resolve({ code, state }));
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for the OAuth callback.`))),
      timeoutMs
    );

    server.on("error", (err) => finish(() => reject(err)));
    // Bind to loopback only: the callback must never be reachable from the network.
    server.listen(port, "127.0.0.1");
  });
}
