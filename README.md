# pi-omniroute-bridge

Pi extension that onboards an OmniRoute instance and keeps Pi custom model metadata synced from OmniRoute.

## What it does

- Prompts for OmniRoute base URL and `OMNI_API_KEY` with `/omniroute-onboard`.
- Fetches `GET {baseUrl}/v1/models` with `Authorization: Bearer <OMNI_API_KEY>`.
- Caches the raw OmniRoute model response and normalized Pi model list at `~/.pi/agent/omniroute-bridge/models-cache.json`.
- Writes/updates the `omniroute` provider in Pi's `~/.pi/agent/models.json`.
- Supports manual sync via `/omniroute-sync` and daily sync on Pi session start.
- Exposes status/config/cache through commands and the `omniroute_status` tool.

## Install

```bash
cd ~/Projects/Personal/pi-omniroute-bridge
npm install
npm run build
npm run install:pi
```

Then in Pi:

```text
/reload
/omniroute-onboard
```

For development without building:

```bash
npm run dev:link
```

## Commands

- `/omniroute-onboard` — prompt for base URL + `OMNI_API_KEY`, choose daily sync, run first sync.
- `/omniroute-sync` — fetch OmniRoute `/v1/models`, update cache, update Pi `models.json`.
- `/omniroute-config` — show current bridge config with redacted API key.
- `/omniroute-config edit` — edit JSON config, including filters and sync interval.
- `/omniroute-cache` — summarize cached models.

## Files

Bridge-owned files:

- `~/.pi/agent/omniroute-bridge/config.json`
- `~/.pi/agent/omniroute-bridge/models-cache.json`

Pi-owned file updated by this extension:

- `~/.pi/agent/models.json`

The provider entry written to `models.json` looks like:

```json
{
  "providers": {
    "omniroute": {
      "baseUrl": "http://localhost:20128/v1",
      "apiKey": "$OMNI_API_KEY",
      "api": "openai-completions",
      "authHeader": true,
      "models": [
        { "id": "provider/model", "name": "provider/model" }
      ]
    }
  }
}
```

> Important: the bridge stores `OMNI_API_KEY` in its config to fetch `/v1/models`, but Pi model requests resolve `apiKey: "$OMNI_API_KEY"` from your shell environment. Export `OMNI_API_KEY` before launching Pi.

## Configuration

Edit with `/omniroute-config edit`:

```json
{
  "baseUrl": "http://localhost:20128",
  "apiKey": "sk-...",
  "enabled": true,
  "dailySync": true,
  "syncIntervalHours": 24,
  "providerId": "omniroute",
  "includePattern": "",
  "excludePattern": "embedding|image"
}
```

- `includePattern` and `excludePattern` are case-insensitive JavaScript regular expressions matched against model id/name.
- `providerId` controls the key under `providers` in Pi `models.json`.

## Relevant docs understood

From Pi `docs/models.md`:

- Custom providers live in `~/.pi/agent/models.json` under `providers`.
- OpenAI-compatible chat proxies should use `api: "openai-completions"`.
- `baseUrl`, `apiKey`, `headers`, `authHeader`, and `models` are provider fields.
- `apiKey` supports env interpolation like `$OMNI_API_KEY`; Pi intentionally does not cache command-resolved values, so this extension handles caching externally.

From OmniRoute docs:

- OmniRoute defaults to local API `http://localhost:20128`.
- OpenAI-compatible endpoints are under `/v1`, including `/v1/chat/completions` and `/v1/models`.
- `/v1/models` requires Bearer API key auth and returns an OpenAI-style `{ object: "list", data: [...] }` model list.
