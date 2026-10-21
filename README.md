# modelis-openai

**Use [Modelis](https://modelishub.com) in Aider, Cline, Continue, or any OpenAI SDK — one `base_url`, one key for GPT / Claude / Gemini, zero migration.**

Modelis is an OpenAI-compatible gateway. With a Modelis account key, point your tool straight at it:

| Setting  | Value                                      |
|----------|--------------------------------------------|
| Base URL | `https://modelishub.com/v1`                |
| API key  | your Modelis key (`sk-…`)                  |
| Model    | `modelis-auto` (the standard tier)         |

`modelis-auto` auto-routes each request. It is the standard tier, the same router as `modelis-auto:standard`. Public auto ids use the colon tiers below. Call a named model by its own id (for example `claude-sonnet-4-6`). Do not prefix a model name with `modelis-auto:` and do not append `:high` or `:low`.

| Model | Per call, within the limit | Input / output limit |
|-------|----------------------------|----------------------|
| `modelis-auto:basic` | $0.004 | 4k / 1k tokens |
| `modelis-auto` and `modelis-auto:standard` | $0.02 | 8k / 2k tokens |
| `modelis-auto:premium` | $0.05 | 4k / 1k tokens |

Above those limits the request is billed per token. Named models (for example `claude-sonnet-4-6` or `deepseek-v4-flash`) are billed per token at the upstream price. Top-ups add a 15% service fee ($10 or ¥72 becomes $8.70 of credit). About 95 models are on the gateway. New accounts get **$1 of free credit**. In the console Wallet, pay by card through Creem, or with Alipay/WeChat through an Afdian redemption code. Billing write-up: https://modelishub.com/about. Live per-model rates: https://modelishub.com/api/pricing.

RapidAPI sells a separate key (`X-RapidAPI-Key`; the Basic plan is 100 requests a month). Coding tools send `Authorization: Bearer`. This package is the single-file bridge for that key: a **zero-dependency local proxy** that speaks the OpenAI wire protocol on `127.0.0.1`, rewrites the auth, and forwards to Modelis. A Modelis account key calls `https://modelishub.com/v1` directly.

```
your tool ──OpenAI(Bearer)──▶ modelis-openai (localhost) ──X-RapidAPI-Key──▶ Modelis on RapidAPI
```

---

## Quickstart

**Modelis account (direct):** sign up at https://modelishub.com — new accounts get $1 of free credit — create a token, and use the table above. No proxy.

**RapidAPI key:** subscribe on the pricing page (Basic plan, 100 requests a month), then copy your key:
👉 https://modelishub.com/pricing

**Run with Node (18+):**

```bash
npx modelis-openai
# or:  node modelis-openai.mjs
```

**Run with Docker (no Node needed):**

```bash
git clone https://github.com/modelishub/modelis-openai
cd modelis-openai
docker build -t modelis-openai .
docker run --rm -p 8787:8787 modelis-openai
```

Then point your tool at the proxy:

| Setting   | Value                          |
|-----------|--------------------------------|
| Base URL  | `http://127.0.0.1:8787/v1`     |
| API key   | *your RapidAPI key*            |
| Model     | `modelis-auto`                 |

The proxy rewrites the request model to `modelis-auto` (standard tier: $0.02 within 8k input / 2k output tokens, then per token). Set `MODELIS_MODEL` to another tier, or to `""` to pass the tool's model through.

Verify the proxy is alive:

```bash
curl http://127.0.0.1:8787/health
```

---

## Tool recipes

### Direct gateway (Modelis account key)

```python
from openai import OpenAI
client = OpenAI(base_url="https://modelishub.com/v1", api_key="sk-YOUR-TOKEN")
print(client.chat.completions.create(
    model="modelis-auto",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://modelishub.com/v1", apiKey: "sk-YOUR-TOKEN" });
const r = await client.chat.completions.create({
  model: "modelis-auto:basic", // or modelis-auto, modelis-auto:premium, or a named model id
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);
```

### Aider (RapidAPI key, via this proxy)
```bash
export OPENAI_API_BASE=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=<your-rapidapi-key>
aider --model openai/modelis-auto
```

### Cline / Roo Code (VS Code)
- **API Provider:** `OpenAI Compatible`
- **Base URL:** `http://127.0.0.1:8787/v1` for a RapidAPI key, or `https://modelishub.com/v1` for a Modelis account key
- **API Key:** *your RapidAPI key*, or your Modelis `sk-…` token
- **Model ID:** `modelis-auto`

### Continue (`~/.continue/config.yaml`)
```yaml
models:
  - name: Modelis
    provider: openai
    model: modelis-auto
    apiBase: http://127.0.0.1:8787/v1
    apiKey: <your-rapidapi-key>
```

For a Modelis account key, set `apiBase` to `https://modelishub.com/v1` and `apiKey` to your `sk-…` token. Other tiers are `modelis-auto:basic` and `modelis-auto:premium`. A named model is its own id, such as `deepseek-v4-flash`.

### Any OpenAI SDK (RapidAPI key, via this proxy)
```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="<your-rapidapi-key>")
print(client.chat.completions.create(
    model="modelis-auto",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "<your-rapidapi-key>" });
const r = await client.chat.completions.create({
  model: "modelis-auto",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);
```

> **Cursor:** Cursor sends requests from its own servers, so a `localhost`
> endpoint won't reach this proxy. Use a Modelis account key with
> `base_url` `https://modelishub.com/v1`, or expose the proxy on a public URL
> you control. The local setup above is for tools that call the API from your
> machine (Aider, Cline, Continue, scripts).

---

## How it works

Streaming (`stream: true`) is piped straight through, so token-by-token output in
your tool works exactly as with the OpenAI API. The proxy:

1. reads the key from `Authorization: Bearer <key>` (or `MODELIS_RAPIDAPI_KEY`),
2. rewrites the request `model` to `modelis-auto` (the standard tier; configurable),
3. forwards to the RapidAPI gateway with `X-RapidAPI-Key` / `X-RapidAPI-Host`,
4. streams the response back unchanged.

It also answers `GET /v1/models` and `GET /health` so tools that probe on
startup don't error. `GET /v1/models` lists `modelis-auto`, the id this proxy
forwards by default. The full auto-router set exported from the module is
`modelis-auto`, `modelis-auto:basic`, `modelis-auto:standard`, and
`modelis-auto:premium`.

---

## Configuration

All optional — sensible defaults work out of the box.

| Env var                      | Default                              | Purpose |
|------------------------------|--------------------------------------|---------|
| `MODELIS_PORT`               | `8787`                               | Local listen port |
| `MODELIS_HOST`               | `127.0.0.1`                          | Local bind address (`0.0.0.0` in Docker) |
| `MODELIS_RAPIDAPI_KEY`       | *(unset)*                            | Fallback key if your tool can't send one |
| `MODELIS_MODEL`              | `modelis-auto`                       | Model sent upstream (standard tier). Set `modelis-auto:basic` or `modelis-auto:premium` for another tier, or `""` to pass the tool's model through |
| `MODELIS_RAPIDAPI_HOST`      | `modelis-auto-chat.p.rapidapi.com`   | RapidAPI gateway host (from your Code Snippet) |
| `MODELIS_UPSTREAM_PATH`      | `/v1/chat/completions`               | Upstream endpoint path |

---

## Privacy & trust

- Runs entirely on your machine; the only outbound connection is to the RapidAPI
  gateway over HTTPS.
- It does **not** log, store, or inspect message contents — it only swaps the
  auth header and forwards bytes.
- One file, no third-party dependencies. Read it.

## Develop

```bash
node --test     # unit + in-process integration tests, zero deps
```

## License

MIT
