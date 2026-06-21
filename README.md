# AI Gateway OpenSource Bundle

English | [简体中文](./README.zh-CN.md)

This repository is a bundled open-source workspace that brings together:

- a **Claude proxy**
- a **Codex proxy**
- a **unified token / quota / health status API**

The goal is not to rewrite these projects from scratch. The goal is to package a **usable AI gateway platform** in one place, so other people can quickly understand:

- what the platform does
- why Claude / Codex subscription access can be used programmatically
- how multi-account, quota, and health states are managed
- how to install, run, and verify the whole stack

## 1. What This Bundle Contains

This folder is a grouped repository with three major parts:

1. `claude-code-proxy`
   Wraps Claude Web / Claude Code authentication into an Anthropic `messages`-compatible proxy and includes a lightweight dashboard.

2. `codex-proxy`
   Wraps Codex Desktop / ChatGPT capabilities into OpenAI / Anthropic / Gemini / Codex-compatible proxy interfaces, with multi-account pooling and quota management.

3. `ai-token-status-api.js`
   A unified status API that normalizes Claude and Codex account state, availability, token lifecycle, and quota windows into machine-readable JSON.

## 2. What Problems It Solves

In practical terms, this platform solves the usual mess around:

- scattered accounts
- opaque quota usage
- hard-to-read health status
- inconsistent client integration paths

You can think of it as a local or private AI gateway layer:

- For application developers:
  they only need a stable proxy endpoint instead of dealing with account rotation, refresh tokens, or provider-specific details.

- For operators:
  they can see which account is usable, how much quota remains, when tokens expire, and why something is currently failing.

- For integrators:
  Claude, Codex, and the status center are all exposed over HTTP and can be queried without opening desktop client UIs.

## 3. Repository Layout

```text
opensource/
├── README.md
├── README.zh-CN.md
├── ai-token-status-api.js
├── aa.sh
├── pngs/
│   ├── claude-proxy.png
│   └── codex-proxy.png
├── claude-code-proxy/
└── codex-proxy/
```

Notes:

- `claude-code-proxy/`
  contains the organized Claude proxy source, including the added dashboard, local multi-account persistence, and status integration.

- `codex-proxy/`
  contains the organized Codex proxy source, responsible for account pools, protocol conversion, model routing, and quota caching.

- `ai-token-status-api.js`
  is the additional unified status service introduced for this bundle.

- `aa.sh`
  is the simplified top-level operations script.

## 4. Screenshots

### Claude / Platform State View

![Claude Proxy Dashboard](./pngs/claude-proxy.png)

### Codex Multi-Account Pool and Quota Dashboard

![Codex Proxy Dashboard](./pngs/codex-proxy.png)

## 5. Core Features

### 5.1 Claude Proxy Features

- OAuth login for Claude, without requiring an official Anthropic developer API key
- Anthropic `POST /v1/messages` compatibility
- built-in management dashboard at `/dashboard`
- local multi-account storage, with a single `active` account used for routing
- visualized monitoring for:
  - 5-hour quota window
  - 7-day quota window
  - token expiry
  - locally accumulated token usage

### 5.2 Codex Proxy Features

- multi-account account pool
- OpenAI / Anthropic / Gemini / Codex multi-protocol support
- automatic routing based on account plan
- quota caching, health checks, and derived account state
- multi-account rotation modes:
  - least-used first
  - round-robin
  - sticky

### 5.3 Unified Status API

- one endpoint for both Claude and Codex
- normalized output for:
  - service reachability
  - authentication state
  - account usability
  - token expiry
  - quota reset time
  - current failure reason

## 6. How It Works

### 6.1 The Most Important Point

This platform does **not create official developer API keys**.

Instead, it does this:

- obtains the login state already used by official web or desktop clients
- reuses the backend endpoints those official clients already call
- re-exposes them as more familiar API-style interfaces

So the real model is:

**It turns a subscription account's existing client-accessible inference channel into a programmable local gateway.**

### 6.2 Why Claude Can Be Called “Like an API”

The Claude path is essentially:

1. browser OAuth login to Claude
2. local storage of `access_token` / `refresh_token`
3. direct Bearer-token requests to:

```text
https://api.anthropic.com/v1/messages
```

4. reformat and return the result to the caller

That means:

- this does not generate an Anthropic Console API key
- it reuses the authentication and request path used by Claude Web / Claude Code

### 6.3 Why Codex Can Be Called “Like an API”

The Codex path is essentially:

1. obtain a token from OpenAI / ChatGPT login state
2. call the backend endpoint used by Codex Desktop:

```text
https://chatgpt.com/backend-api/codex/responses
```

3. translate the result into:
   - OpenAI Chat Completions
   - Anthropic Messages
   - Gemini
   - Codex Responses

So again, it is not creating new privileges. It is **wrapping capabilities already available through the official client flow**.

## 7. How This Differs From Official Developer APIs

This distinction matters.

### What It Can Do

- send inference requests using the model access already available to a subscription account
- operate inside the subscription account's real quota windows
- expose that access through more standard interfaces for tools and services

### What It Cannot Do

- it is not equivalent to an official developer platform API key
- it does not bypass model access restrictions tied to the account plan
- it does not bypass 5-hour / 7-day / quota / rate-limit constraints
- it cannot reliably provide consumer subscription billing renewal dates

## 8. Recommended Ports

Recommended port layout:

- Claude proxy: `42069`
- Codex proxy: `8080`
- Status API: `42124`

## 9. Prerequisites

Recommended environment:

- Linux / macOS
- Node.js 20+
- npm

Extra dependency:

- `codex-proxy` source runs are best paired with a Rust toolchain because of its native TLS component

Account prerequisites:

- Claude path: a valid Claude Pro / Max account or usable Claude login state
- Codex path: a valid ChatGPT / Codex-capable account

## 10. Installation

### 10.1 Claude Proxy

```bash
cd /path/to/opensource/claude-code-proxy
npm install
```

Start it:

```bash
npm start
```

First-time login:

```text
http://localhost:42069/auth/login
```

### 10.2 Codex Proxy

The simplest way to think about `codex-proxy` is that it remains a standalone project inside this bundle.

Source-run setup:

```bash
cd /path/to/opensource/codex-proxy
npm install
cd web && npm install && cd ..
```

If you need the native TLS component:

```bash
cd native
npm install
npm run build
cd ..
```

Start in development mode:

```bash
npm run dev
```

Or build and run:

```bash
npm run build
npm start
```

Open:

```text
http://localhost:8080
```

### 10.3 Unified Status API

This file is framework-free and can be started directly with Node:

```bash
cd /path/to/opensource
node ai-token-status-api.js
```

Default bind:

```text
http://127.0.0.1:42124
```

Optional environment variables:

```bash
AI_STATUS_PORT=42124
AI_STATUS_HOST=127.0.0.1
CLAUDE_STATUS_BASE_URL=http://127.0.0.1:42069
CODEX_STATUS_BASE_URL=http://127.0.0.1:8080
AI_STATUS_TIMEOUT_MS=8000
```

## 11. Minimal Working Setup

If you just want to validate the platform quickly, use this order:

1. start `codex-proxy`
2. start `claude-code-proxy`
3. start `ai-token-status-api.js`

Then verify:

```bash
curl http://127.0.0.1:42069/auth/status
curl http://127.0.0.1:8080/auth/status
curl http://127.0.0.1:42124/health
curl http://127.0.0.1:42124/api/status
```

## 12. Usage Examples

### 12.1 Call Claude

```bash
curl http://127.0.0.1:42069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 32,
    "messages": [
      {"role": "user", "content": "Reply with exactly: ok"}
    ]
  }'
```

### 12.2 Call Codex

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-proxy-api-key" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### 12.3 Query Unified Status

```bash
curl http://127.0.0.1:42124/api/status
curl http://127.0.0.1:42124/api/status/claude
curl http://127.0.0.1:42124/api/status/codex
curl "http://127.0.0.1:42124/api/status?refresh=1"
```

## 13. How To Think About Multi-Account Scenarios

### Claude

- multiple accounts can be stored
- but only one `active` account participates in live routing
- status evaluation should focus on:
  - `active_account_id`
  - active account `usable`
  - `refresh_ok`

### Codex

- this is a real account pool
- multiple accounts may be `usable=true` at the same time
- responses are not merged into a single averaged pool value
- the caller should choose its own strategy

Recommended filtering logic:

1. filter `usable=true`
2. sort by `rate_limit.used_percent` ascending
3. then sort by `expires_at` descending

## 14. The Most Commonly Misunderstood Fields

Pay attention here:

- Claude `token_expires_at`
  is **not** the Claude Pro / Max billing renewal date
- Codex `expires_at`
  is **not** the ChatGPT Plus / Pro subscription renewal date

They both only represent:

**the current authentication token's expiry time**

That means:

- when a token expires, the service may still continue if refresh works
- only when refresh also fails does the platform become truly unusable

## 15. Top-Level Operations Script

Top-level [aa.sh](./aa.sh) provides a lightweight local operations entrypoint.

Available commands:

```bash
./aa.sh ports
./aa.sh start-claude
./aa.sh stop-claude
./aa.sh start-status
./aa.sh stop-status
./aa.sh health
./aa.sh logs
```

Notes:

- this script is mainly for starting / stopping the Claude proxy and status API
- `codex-proxy` has a more complex startup shape, so it is better to operate it directly from its own project directory

## 16. How To Read The Screenshots

Inside `pngs/`:

- `claude-proxy.png`
  focuses on Claude account management, quota windows, and dashboard operations

- `codex-proxy.png`
  focuses on multi-account pools, per-account rate limits, weekly windows, and proxy assignment

## 17. Known Limits

- Claude consumer subscription renewal dates cannot be reliably queried through this bundle
- Codex / ChatGPT Plus consumer renewal dates also cannot be reliably queried through this status layer
- the platform depends on currently usable authentication flows exposed by official web or desktop clients
- if tokens expire, refresh tokens are revoked, or upstream anti-abuse behavior changes, platform capabilities will be affected

## 18. Licensing and Upstream Attribution

This directory is **not** "two completely new proxies written from scratch". It is a bundled integration workspace.

Specifically:

- `claude-code-proxy/`
  is based on an upstream project and currently declares `MIT` in its `package.json`

- `codex-proxy/`
  comes from a separate upstream project; its README explicitly signals a `Non-Commercial` licensing direction

So before publishing, redistributing, or using this bundle commercially, you must separately review and comply with each upstream project's own license, notice, and usage restrictions.

When publishing a public repository, keep:

- original READMEs
- original package metadata
- original LICENSE / notice files
- your own integration-layer explanation

## 19. One-Sentence Summary

You can think of this directory as:

**a bundled AI gateway platform source package that combines Claude, Codex, and a unified status center.**

Its main value is not just “calling one model.” Its real value is:

**bringing multiple subscription accounts, multiple protocols, quota visibility, and operations workflows into one manageable layer.**
