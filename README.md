# Platinum Cubed MCP — Salesforce for Claude

Connect any Salesforce org to Claude with one click. Two tiers: Read Only and Full Access.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. In Railway: New Project → Deploy from GitHub → select your repo
3. Add environment variables:
   - `PC_CLIENT_ID` — your Salesforce Connected App Consumer Key
   - `PC_CLIENT_SECRET` — your Salesforce Connected App Consumer Secret
   - `SERVER_URL` — your Railway URL (e.g. https://platinum-cubed-mcp.railway.app)
4. Railway auto-deploys on every push

## Salesforce Connected App Setup

1. Setup → App Manager → New Connected App
2. Enable OAuth Settings ✅
3. Callback URL: `https://YOUR-RAILWAY-URL/oauth/callback`
4. Scopes: Full access, Perform requests at any time
5. Enable Client Credentials Flow ✅ (optional, for server-to-server)
6. Save → wait 10 mins → copy Consumer Key & Secret

## How it works

- Users visit your Railway URL
- Enter their Salesforce instance URL
- Click Connect → authorizes via Salesforce OAuth
- Get their personal MCP URL to add to Claude Desktop or Claude.ai

## Endpoints

- `GET /` — Landing page
- `GET /oauth/start?tier=readonly|full&instance_url=...` — Start OAuth
- `GET /oauth/callback` — OAuth callback
- `POST /mcp/readonly?session=...` — Read-only MCP
- `POST /mcp/full?session=...` — Full access MCP
- `GET /health` — Health check
