# Wrapper Agent Context

## Purpose

This repo is the voice-channel orchestrator. It is a thin client + local server that listens for the wake phrase, keeps a persistent conversation/session id, and routes user utterances to the correct backend agent.

The wrapper is **not** responsible for banking logic, push notifications, order creation, or payment approval. Those belong to the GCP bridges and the BBVA demo PWA.

## Topology

- `pwa/`: standalone voice PWA used in the browser.
- `server.mjs`: local Node server that proxies chat/session calls.
- `origin`: GitHub repo `https://github.com/acardonag/wrapper`.

## Runtime flow

1. User says `BBVA Compras`.
2. PWA captures speech via `SpeechRecognition`.
3. The utterance is normalized and turned into a `prompt`.
4. `server.mjs` forwards the prompt to the configured agent backend.
5. The response is spoken with `speechSynthesis`.
6. For follow-up flows, the wrapper polls the appropriate result endpoint and keeps the same `clientSessionId`.

## Session model

The wrapper maintains a persistent session id per listening session:

- `clientSessionId`: local browser session id used to correlate all prompts.
- `session-result`: auth state, sourced from `ces-session-bridge`.
- `purchase-result`: payment state, sourced from `voice-commerce-bridge`.

The wrapper must not conflate auth and payment states. Auth completion lives in `session-result`; payment completion lives in `purchase-result`.

## Current backend wiring

- `AGENT_PROVIDER=ces-session-bridge`
- `CES_SESSION_BRIDGE_BASE=https://ces-session-bridge-1003987130329.us-central1.run.app`
- `AGENT_ALLOW_INSECURE_TLS=true` for local testing only.

Local server endpoints:

- `GET /api/health`
- `POST /api/chat`
- `GET /api/session-result?sessionId=...`
- `GET /api/purchase-result?sessionId=...`

## Critical contracts

### Auth

- `POST /api/chat` with a cedula prompt triggers lookup/auth.
- The auth result may return:
  - `Autenticación en proceso...`
  - `Autenticación aprobada...`
  - `Pagos Inteligentes no está activado...`

### Purchase

- A product selection triggers `request-purchase` against the voice commerce bridge.
- `purchase-result` should eventually move from:
  - `PAYMENT_REQUESTED`
  - to `APROBADO`

## Failure modes to watch

- Duplicate purchase requests caused by repeated voice follow-ups.
- Session mismatch between wrapper and payment approval page.
- Polling reading stale auth state during payment mode.
- CORS or service-worker caching issues when testing locally.

## Operational notes

- Do not version `node_modules/`.
- Do not put secrets in the repo.
- For local smoke tests, keep the wrapper on `http://localhost:8095`.

