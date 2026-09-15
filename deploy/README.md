# Deploying saxo-mcp over HTTPS

Architecture:

```
Internet ──HTTPS 443──▶ Caddy (TLS, Let's Encrypt) ──HTTP──▶ 127.0.0.1:3000 saxo-mcp-http ──▶ Saxo OpenAPI
                                                              (bearer token required)
```

The MCP HTTP server never listens on a public interface. Only Caddy is exposed.

## 1. Environment

Add to `/path/to/saxo-mcp/.env` (mode 600):

```
MCP_ACCESS_TOKEN=<output of: openssl rand -hex 32>
HTTP_PORT=3000
```

## 2. Caddy

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy          # after any Caddyfile change
sudo systemctl status caddy
sudo journalctl -u caddy -f          # watch the certificate being issued
```

## 3. pm2

```bash
cd /path/to/saxo-mcp && npm run build
pm2 start dist/http-server.js --name saxo-mcp-http --cwd /path/to/saxo-mcp
pm2 save
pm2 status
pm2 logs saxo-mcp-http
```

The existing `saxo-mcp` (stdio) process is untouched.

## 4. Firewall

```bash
sudo ufw allow 80/tcp     # Let's Encrypt HTTP-01 challenge + HTTP->HTTPS redirect
sudo ufw allow 443/tcp    # HTTPS
sudo ufw status
```

Port 3000 stays closed; it is loopback-only. Open 80 and 443 in your cloud
provider's network security list as well.

## 5. Verify

```bash
curl -s https://saxo-mcp.duckdns.org/healthz                 # -> ok
curl -s -o /dev/null -w "%{http_code}\n" https://saxo-mcp.duckdns.org/mcp   # -> 401
curl -s -X POST https://saxo-mcp.duckdns.org/mcp \
  -H "Authorization: Bearer $MCP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

MCP client configuration:

```json
{
  "mcpServers": {
    "saxo": {
      "type": "streamable-http",
      "url": "https://saxo-mcp.duckdns.org/mcp",
      "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }
    }
  }
}
```
