# modelis-openai

**Use [Modelis](https://modelishub.com) in Aider, Cline, Continue, or any OpenAI SDK — one `base_url`, one key for GPT / Claude / Gemini, zero migration.**

Modelis auto-routes every request to the best model (GPT / Claude / Gemini) and
bills a **flat, predictable price per call — not per token**. It's distributed
through RapidAPI, which uses an `X-RapidAPI-Key` header instead of the
`Authorization: Bearer` header that coding tools expect.

This is the ~120-line bridge: a **zero-dependency local proxy** that speaks the
OpenAI wire protocol on `127.0.0.1`, rewrites the auth, and forwards to Modelis.
Point any OpenAI-compatible tool at it and you're done.

```
your tool ──OpenAI(Bearer)──▶ modelis-openai (localhost) ──X-RapidAPI-Key──▶ Modelis on RapidAPI ──▶ best model
```

---

## Quickstart

You need a Modelis API key (free tier to start). Get one and see all plans on the
pricing page — subscribe, then copy your key:
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

Then point your tool at:

| Setting   | Value                          |
|-----------|--------------------------------|
| Base URL  | `http://127.0.0.1:8787/v1`     |
| API key   | *your RapidAPI key*            |
| Model     | `modelis-auto`                 |

That's it. Verify it's alive:

```bash
curl http://127.0.0.1:8787/health
```

---

## Tool recipes

### Aider
```bash
export OPENAI_API_BASE=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=<your-rapidapi-key>
aider --model openai/modelis-auto
```

### Cline / Roo Code (VS Code)
- **API Provider:** `OpenAI Compatible`
- **Base URL:** `http://127.0.0.1:8787/v1`
- **API Key:** *your RapidAPI key*
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

### Any OpenAI SDK
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
> endpoint won't reach this proxy. Use Cursor only if you expose the proxy on a
> public URL you control. The local setup above is for tools that call the API
> from your machine (Aider, Cline, Continue, scripts).

---

## How it works

Streaming (`stream: true`) is piped straight through, so token-by-token output in
your tool works exactly as with the OpenAI API. The proxy:

1. reads the key from `Authorization: Bearer <key>` (or `MODELIS_RAPIDAPI_KEY`),
2. rewrites the request `model` to `modelis-auto` (configurable),
3. forwards to the RapidAPI gateway with `X-RapidAPI-Key` / `X-RapidAPI-Host`,
4. streams the response back unchanged.

It also answers `GET /v1/models` and `GET /health` so tools that probe on
startup don't error.

---

## Configuration

All optional — sensible defaults work out of the box.

| Env var                      | Default                              | Purpose |
|------------------------------|--------------------------------------|---------|
| `MODELIS_PORT`               | `8787`                               | Local listen port |
| `MODELIS_HOST`               | `127.0.0.1`                          | Local bind address (`0.0.0.0` in Docker) |
| `MODELIS_RAPIDAPI_KEY`       | *(unset)*                            | Fallback key if your tool can't send one |
| `MODELIS_MODEL`              | `modelis-auto`                       | Model sent upstream; set `""` to pass the tool's model through |
| `MODELIS_RAPIDAPI_HOST`      | `modelis-auto-chat.p.rapidapi.com`   | RapidAPI gateway host (from your Code Snippet) |
| `MODELIS_UPSTREAM_PATH`      | `/v1/chat/completions`               | Upstream endpoint path |

---

## Privacy & trust

- Runs entirely on your machine; the only outbound connection is to the RapidAPI
  gateway over HTTPS.
- It does **not** log, store, or inspect message contents — it only swaps the
  auth header and forwards bytes.
- ~120 lines, no third-party dependencies. Read it.

## Develop

```bash
node --test     # unit + in-process integration tests, zero deps
```

## License

MIT
