# Product Requirements Document (PRD)

**Product:** AI Chatbot Demo App  
**Audience:** Solutions Engineers / technical users  
**Prepared:** 2025-10-06

---

## 1) Overview
**Goals:** Showcase (a) model switching (incl. “thinking” models via Ollama), (b) MCP tool use across transports (stdio / SSE / streamtable HTTP), (c) RAG over local files, and (d) clear, inspectable execution traces.

## 2) Success Criteria
- A user can: log in, upload docs, start chats, toggle RAG, pick an LLM and MCP servers per conversation, and view a detailed internal activity modal.  
- When an assistant reply finishes, the UI plays a brief confirmation sound so the user knows the response is ready.  
- While a message send is in-flight, the composer controls (input, send button, model/persona and RAG/streaming toggles) disable and the primary action switches to Cancel, without obscuring the chat workspace; the sidebar remains visible but non-interactive, and any open internal activity modal shows a disabled state.  
- The chat composer remains pinned to the bottom of the viewport and the transcript auto-scrolls to new messages.  
- MCP server management opens in a modal launched from the chat toolbar.  
- All config is admin-defined JSON under `/config/*.json` and loaded at startup (fail-fast on invalid schema).  
- Runs locally and via `docker-compose`.  
- Branding uses F5 colors (primary red **#E21D38** and white).

## 3) Non-Goals
- No SSO/OAuth (email+password only).  
- No moderation/filters.  
- No analytics/audit dashboards.  
- No side-by-side model compare in MVP.

## 4) User Roles
- Single role for MVP (all users identical).

## 5) Platforms & Tech
- **Frontend:** React + Vite (JS), no TypeScript.  
- **Backend:** FastAPI (async); streaming support available but **disabled by default** (user-toggle per chat).  
- **LLMs:** Ollama (discover models at runtime; support “thinking” variants).  
- **RAG:** SQLite + vector extension (e.g., `sqlite-vec`/`sqlite-vss`).  
- **MCP:** transports = stdio, SSE (Server-Sent Events), and streamtable HTTP.

## 6) Authentication & Security (Demo-Level)
- **Login:** email + password (local).  
- **Passwords:** hashed (bcrypt).  
- **JWT:** stateless, HMAC-signed; access token lifetime **24h**; no refresh tokens.  
- **CORS:** allow all (demo).  
- **Secrets:** `/config/secrets.json`.  
- **No lockouts / no password policy**.

## 7) Data & Storage
- **SQLite** (single file): `app.db`  
- **File storage:** `/data/uploads`  
- **RAG index:** SQLite tables inside `app.db` (no separate cap).  
- **Retention:** local-only; no auto-delete; user can manually delete files/chats.

### 7.1 Database Schema (Initial)
- `users`(id, email [unique], password_hash, full_name, title, team, avatar_url, created_at)  
- `sessions`(id, user_id, created_at, title, model_id, persona_id, rag_enabled, streaming_enabled)  
- `messages`(id, session_id, role [user|assistant|system|tool], content, created_at, edited_from_message_id NULL)  
- `uploads`(id, user_id, filename, path, mime, size_bytes, created_at)  
- `trace_runs`(id, session_id, started_at, finished_at, status, model_id, total_tokens, prompt_tokens, completion_tokens, latency_ms)  
- `trace_steps`(id, run_id, ts, type [prompt|rag|tool|mcp|model], label, input_json, output_json, latency_ms)  
- `rag_documents`(id, upload_id, doc_type [pdf|md|txt|docx|mdx], title, meta_json)  
- `rag_chunks`(id, document_id, chunk_index, text, embedding BLOB/VECTOR, token_count)  
- `config_cache`(key, json, loaded_at, version)

> Vector column uses the chosen SQLite vector extension; index created via the extension’s recommended API.

## 8) File Handling
- Allowed: **.pdf, .md, .txt, .docx, .mdx**  
- Max size per file: **5 MB**  
- Upload UI in chat sidebar; show status & parse results.

## 9) RAG Pipeline (Configurable)
- Chunking & overlap configurable (defaults in `/config/rag.json`).  
- Embeddings: configurable model (Ollama embedding) + dimension.  
- Vector store: SQLite + vector extension; cosine similarity.  
- Retrieval: top-k configurable.  
- No source citations in final answers (by design), but retrieved passages appear on the **internal activity** page.

## 10) Model Selection
- Discover available Ollama models at runtime (via Ollama API).  
- Per-conversation model choice; UI dropdown in chat header.  
- “Thinking” models supported if available in Ollama.  
- **Note:** The app does **not** store or display literal chain-of-thought; only model outputs and optional summaries.

## 11) MCP Integration
- Configured servers defined by admin in `/config/mcp.json`.  
- User can enable/disable a subset per conversation (checkbox list).  
- Auth: API keys read from `/config/secrets.json` (mapped by server name).  
- Transports supported: **stdio**, **SSE**, **streamtable HTTP**.

## 12) Internal Activity Modal (Tracing)
- Scope: only the **signed-in user’s** sessions.  
- Primary UX goal: at-a-glance comprehension of the execution flow (Prompt → Retrieval → Tool/MCP → Model) with optional deep dives into the raw payloads.  
- Layout:
  - **Run list rail:** status badge, started timestamp, model id; selecting a run loads its detail view.  
  - **Run summary card:** latency, duration, token counts, model, retry indicator.  
  - **Linear timeline cards:** vertically stacked steps that clarify every handoff:
    - **User Prompt:** quick preview (first ~200 chars + token count) with details showing the exact payload sent.
    - **Retrieval Payload:** shown when RAG executes; quick view highlights chunk count + top snippet, expansion reveals full retrieved text/metadata.
    - **Tool / MCP Execution:** one card per call; quick view surfaces tool name, MCP transport, status; expansion shows function signature, arguments, outputs.
    - **LLM Input:** summarises what the model actually consumed (prompt + injected tool outputs); details expose the compiled prompt JSON/text with copy action.
    - **LLM Response:** distinguishes between final assistant reply and tool requests; quick view shows the relevant preview, expansion includes the full response object and reasoning summary if present.
    - **Transport/System badges:** inline indicators for reasoning summaries or transport metadata without opening details.
  - **Phase accordions deprecated:** replaced by the timeline cards above; each card still supports copy-to-clipboard actions within its expanded state.  
- Additional details: per-step latency bar, transport metadata toggle, retrieved chunk previews, tool/MCP call inputs/outputs, assistant deltas.  
- **Important:** No verbatim chain-of-thought is stored or shown; include model-provided **reasoning summaries** when available.  
- **Access:** Launch from the chat header beside the RAG button; opens as a modal that can be dismissed without leaving the chat.

## 13) Config Files (Loaded at Startup; Fail-Fast)
All under `/config/`, validated via JSON Schema.

### 13.1 `/config/models.json` (example)
```json
{
  "default_model": "llama3.1:8b-instruct",
  "allow_user_switch_per_conversation": true,
  "ollama": {
    "base_url": "http://localhost:11434",
    "discover_models": true,
    "prepull": [],
    "request_timeout_seconds": 120
  },
  "thinking_models_allowed": true
}
```

- `request_timeout_seconds` controls both discovery and chat HTTP calls to Ollama; default is 120 seconds to accommodate slower responses and can be tuned per deployment.

### 13.2 `/config/mcp.json`
```json
{
  "servers": [
    {
      "name": "filesystem-tools",
      "transport": "stdio",
      "command": "node",
      "args": ["mcp/fs-server.js"],
      "requires_api_key": false,
      "enabled_by_default": false
    },
    {
      "name": "search-sse",
      "transport": "sse",
      "base_url": "http://localhost:8081",
      "requires_api_key": true,
      "enabled_by_default": false,
      "auth_key_name": "SEARCH_SSE_API_KEY"
    },
    {
      "name": "analytics-streamtable",
      "transport": "streamtable_http",
      "base_url": "http://localhost:9090",
      "requires_api_key": true,
      "enabled_by_default": false,
      "auth_key_name": "ANALYTICS_ST_API_KEY"
    }
  ]
}
```

### 13.3 `/config/rag.json`
```json
{
  "embedding_model": "nomic-embed-text",
  "chunk_size_tokens": 1000,
  "chunk_overlap_tokens": 200,
  "top_k": 5,
  "sqlite": {
    "db_path": "./app.db",
    "vector_extension": "sqlite-vec"
  }
}
```

### 13.4 `/config/personas.json`
```json
{
  "default_persona_id": "se-default",
  "personas": [
    {
      "id": "se-default",
      "name": "Solutions Engineer",
      "system_prompt": "You are a helpful technical solutions engineer. Be concise, cite internal context where relevant, and prefer tool use when asked for concrete data.",
      "default_model_id": "llama3.1",
      "enabled_mcp_servers": ["search-stdio"],
      "rag_enabled": true,
      "streaming_enabled": false
    },
    {
      "id": "debugger",
      "name": "Trace Explainer",
      "system_prompt": "Explain each step you will take before executing tools. Be explicit about assumptions. Do NOT include chain-of-thought.",
      "default_model_id": "llama3.1-thinking",
      "enabled_mcp_servers": [],
      "rag_enabled": false,
      "streaming_enabled": true
    }
  ]
}
```

> **Persona defaults:** When provided, `default_model_id`, `enabled_mcp_servers`, `rag_enabled`, and `streaming_enabled` apply when a session starts with that persona (or when the persona becomes the default). Each field is optional and falls back to the platform defaults if omitted; changing personas later keeps any user overrides.

### 13.5 `/config/secrets.json`
```json
{
  "jwt_secret": "REPLACE_ME_DEMO_ONLY",
  "api_keys": {
    "SEARCH_SSE_API_KEY": "xxx",
    "ANALYTICS_ST_API_KEY": "yyy"
  }
}
```

## 14) API Design (High Level)
- `POST /auth/login` {{ email, password }} → {{ access_token }}  
- `GET /me` → user profile  
- `GET /config` → merged, validated app config (safe subset)  
- `GET /models` → discovered Ollama models  
- `POST /sessions` {{ title?, model_id?, persona_id?, rag_enabled?, streaming_enabled?, enabled_mcp_servers?[] }}  
- `GET /sessions/:id` / `DELETE /sessions/:id` / `PATCH /sessions/:id` (rename, toggles)  
- `POST /sessions/:id/messages` {{ content, attachments? }} → creates a run  
- `GET /sessions/:id/messages` → full history  
- `POST /uploads` (multipart) → store & index if RAG enabled  
- `GET /traces/:run_id` → full run with steps  
- `GET /traces/sessions/:session_id` → runs list

> WebSocket endpoint (optional) for live updates if streaming is toggled on by user.

## 15) Frontend UX
- **Login** → **Workspace**  
- **Left rail:** new chat, list (rename/delete), global settings (read-only view of admin config).  
- **Chat header:** model dropdown, persona dropdown, toggle RAG, choose MCP servers, toggle streaming.  
- **Composer:** pinned to the bottom of the viewport; edit last user message; attach files; send.  
- **Assistant responses:** when backend responses contain `<think>` blocks, show them as a collapsed "Thoughts" bar that expands to reveal the hidden content on demand.  
- **Internal activity modal:** opens per-turn trace with tabs: Timeline • Prompts • RAG • Tools • Metrics.  
- **Branding:** F5 red (#E21D38) accents, neutral backgrounds; avoid low-contrast tints.

## 16) Seeding (One-Time Scripts)
- **Users (5):** realistic placeholders (names, titles, teams, avatar URLs); bcrypt-hashed passwords.  
- **Configs:** validate all `/config/*.json` at startup; fail with descriptive errors.

## 17) Performance
- Streaming disabled by default; user can enable per chat.  
- No rate limits in MVP.  
- Keep entire conversation history (no auto-summarization).

## 18) Deployment
- Single `docker-compose.yml` with services:
  - `frontend` (Vite build & static serve)
  - `backend` (FastAPI + SQLite + vector extension)
  - (Optional) `ollama` is external; URL in config
- Volumes: mount `/data/uploads` and SQLite `app.db`.

## 19) Open Questions / Future Extensions
- Add dark mode and additional brand neutrals if needed.  
- Consider optional refresh tokens & stricter password policy.  
- Add source citations toggle if desired later.  
- Add simple admin CLI for re-indexing & validation.

## 20) Acceptance Tests (MVP)
1. Can log in with a seeded user.  
2. Create chat, pick an Ollama model (list reflects runtime discovery).  
3. Toggle RAG on; upload a PDF; ask a question → model answers; internal page shows retrieval + steps.  
4. Enable an MCP server; run a tool call → trace shows inputs/outputs.  
5. Edit last user message and resend → trace shows new run.  
6. Rename and delete chats.  
7. Hear the confirmation sound when the assistant finishes responding to a newly sent user message.  
8. Restart server with invalid `/config/*.json` → startup fails with clear schema errors.  
9. Branding shows F5 red (#E21D38) accents, readable on white backgrounds.
