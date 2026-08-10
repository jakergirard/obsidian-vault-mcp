# obsidian-vault-mcp

MCP server + Obsidian Sync in one container. It keeps a live local copy of your Obsidian vault (via the official [`obsidian-headless`](https://github.com/obsidianmd/obsidian-headless) sync client) and exposes it over [MCP](https://modelcontextprotocol.io) Streamable HTTP with bearer-token auth, so Claude can read and write your notes from any device: web, mobile, or desktop. Edits made by Claude sync back to all your devices through Obsidian Sync.

```
Claude (any device) --HTTPS--> obsidian-vault-mcp --/vault--> ob sync --continuous <--> Obsidian Sync <--> your devices
```

Requires an [Obsidian Sync](https://obsidian.md/sync) subscription. Not affiliated with Obsidian or Anthropic.

## Quick start (Docker)

```bash
docker run -d --name obsidian-vault-mcp \
  -p 3000:3000 \
  -v /path/to/appdata/vault:/vault \
  -v /path/to/appdata/data:/data \
  -e OBSIDIAN_EMAIL=you@example.com \
  -e OBSIDIAN_PASSWORD='...' \
  -e OBSIDIAN_TOTP_SECRET='BASE32SECRET' \
  -e OBSIDIAN_VAULT='My Vault' \
  --restart unless-stopped \
  ghcr.io/jakergirard/obsidian-vault-mcp:latest
```

Watch the log on first start: it installs `obsidian-headless`, logs in, pulls the vault, prints the generated MCP bearer token, then serves MCP at `http://<host>:3000/mcp`.

Prefer not to put credentials in env vars? Leave `OBSIDIAN_EMAIL`/`OBSIDIAN_PASSWORD` unset and run the interactive login once instead; the session persists in `/data`:

```bash
docker exec -it obsidian-vault-mcp ob login
```

### Unraid

A Community Applications template lives in [`unraid/obsidian-vault-mcp.xml`](unraid/obsidian-vault-mcp.xml). Until it is listed in CA, add this repo as a template repository: `Docker` > `Template Repositories` > add `https://github.com/jakergirard/obsidian-vault-mcp`, then add the container from the template.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OBSIDIAN_EMAIL` | no | | Obsidian account email. Omit to use `docker exec -it <name> ob login` instead. |
| `OBSIDIAN_PASSWORD` | no | | Obsidian **account** password (not the vault encryption password). |
| `OBSIDIAN_VAULT_PASSWORD` | e2ee vaults | | Vault **end-to-end encryption** password, set when the remote vault was created. Required if the vault uses e2ee; leave unset for standard encryption. |
| `OBSIDIAN_TOTP_SECRET` | no | | Base32 TOTP secret if 2FA is enabled (the secret itself, not a 6-digit code). |
| `OBSIDIAN_VAULT` | yes | | Remote vault name, exactly as shown in Obsidian Sync (`ob sync-list-remote` lists them). |
| `MCP_TOKEN` | no | auto | Bearer token clients must send. Auto-generated, printed in the log, and saved to `/data/mcp_token` if unset. |
| `PORT` | no | `3000` | MCP server port. |
| `READ_ONLY` | no | `false` | `true` disables the write tools. |
| `OBSIDIAN_HEADLESS_VERSION` | no | `latest` | Pin the `obsidian-headless` version installed on first start. |

Volumes: `/vault` (the synced vault) and `/data` (Obsidian Sync session, `obsidian-headless` install, generated token). Both should be persistent.

## Exposing it to Claude

**Important:** Claude web and mobile connectors originate from **Anthropic's cloud**, not from your device. A LAN or Tailscale IP is not reachable from there. Pick one:

1. **Tailscale Funnel** (recommended if you run Tailscale): on the Docker host, `tailscale funnel --bg 3000`. You get `https://<host>.<tailnet>.ts.net` with TLS, and nothing else on your network is exposed. Requires HTTPS certs and the `funnel` node attribute enabled in your tailnet policy.
2. **Cloudflare Tunnel**: point a `cloudflared` tunnel at `http://<host>:3000` on a hostname you own.
3. **Reverse proxy**: any HTTPS reverse proxy (Nginx Proxy Manager, Caddy, Traefik) forwarding to port 3000.
4. **LAN / tailnet only**: no public exposure, but then only clients that connect from your own machines work, e.g. Claude Desktop or Claude Code pointed at `http://<tailscale-ip>:3000/mcp`. Claude web and mobile will not work in this mode.

## Connecting Claude

1. Claude `Settings` > `Connectors` > `Add custom connector`
2. URL: `https://<your-public-hostname>/mcp`
3. Request headers: `Authorization: Bearer <your token>` (token is in the container log or `/data/mcp_token`)
4. Enable the connector in a chat and ask Claude to list your vault

## Tools

| Tool | Description |
| --- | --- |
| `read_note` | Read a file (vault-relative path). |
| `write_note` | Create or overwrite a file. |
| `append_note` | Append to a file (created if missing). |
| `patch_note` | Replace an exact, unique string in a file. |
| `list_dir` | List a directory. |
| `search` | Case-insensitive fixed-string search via ripgrep. |

All paths are jailed to `/vault`.

## Security notes

- Anyone with the URL **and** the bearer token can read and write your entire vault. Treat the token like a password; rotate it by changing `MCP_TOKEN` (or deleting `/data/mcp_token`) and restarting.
- Only expose the server over HTTPS (all three public recipes above provide it).
- `READ_ONLY=true` if you only want Claude reading notes.
- Vault contents may include sensitive material; think before exposing.

## Why isn't obsidian-headless in the image?

The `obsidian-headless` npm package is published as `UNLICENSED`, which does not grant redistribution rights, so this image does not bundle it. The entrypoint installs it from npm on first start (into `/data`, so it persists across container updates). The CLI surface (`ob login`, `ob sync-setup`, `ob sync --continuous`) may change upstream; pin `OBSIDIAN_HEADLESS_VERSION` if a new release breaks something, and file an issue.

## License

[MIT](LICENSE)
