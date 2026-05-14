# WealthFlow Elite v6.7.0

> **Sri Lankan personal finance PWA with 18-engine AI vision consensus**

A production-grade financial management app deployed on Vercel that helps you scan receipts, bills, and subscriptions using the world's most advanced AI models — Gemini 3.1 Pro, GPT-4o, Claude 3.5 Sonnet, Grok 2 Vision, and 14 others — voting together for surgical accuracy.

---

## 🚀 What's New in v6.7

### 1. 18 AI engines including 2026's frontier models

| Provider | Model | Used For | Tier |
|---|---|---|---|
| Google | **Gemini 3.1 Pro Preview** | Vision (frontier mode) | Premium |
| Google | Gemini 3 Flash Preview | Vision (frontier mode) | Premium |
| Google | Gemini 2.5 Flash | Vision (all modes) | Free tier |
| Google | Gemini 2.5 Pro | Vision (ultra/frontier) | Free tier |
| Google | Gemini 2.0 Flash | Vision (all modes) | Free tier |
| OpenAI | **GPT-4o** (via GitHub Models) | Vision (ultra/frontier) | **FREE** |
| Anthropic | **Claude 3.5 Sonnet** | Vision (frontier) | Premium |
| xAI | **Grok 2 Vision** | Vision (ultra/frontier) | Paid |
| Meta | Llama 3.2 90B Vision (Ollama) | Vision (all modes) | Free |
| Meta | Llama 3.2 90B Vision (Together) | Vision (ultra/frontier) | **FREE tier** |
| Meta | Llama 3.2 90B Vision (NVIDIA NIM) | Vision (ultra/frontier) | **FREE tier** |
| Meta | Llama 3.2 90B Vision (Groq Llava) | Vision (all modes) | **FREE tier** |
| Alibaba | Qwen 2.5-VL (Ollama) | Vision (ultra/frontier) | Free |
| Alibaba | Qwen 2.5-VL (OpenRouter) | Vision (ultra/frontier) | **FREE** |
| Alibaba | Qwen 2-VL (HuggingFace) | Vision (ultra/frontier) | **FREE** |
| Mistral | Pixtral Large | Vision (all modes) | Free tier |
| Microsoft | Phi-3 Vision (Fireworks) | Vision (ultra/frontier) | Free credits |
| OCR.space | Engine 2 | OCR anchor + text LLM | Free |

**Text-LLM structuring chain** (when vision fails): Gemini 2.0 Flash → Cerebras Llama 3.3 70B → SambaNova Llama 3.3 70B → GitHub Models DeepSeek-R1 → NVIDIA Nemotron 70B → Cohere Command R+ → DeepSeek Chat → Groq Llama 3.3 70B → OpenRouter DeepSeek free.

### 2. PDF Receipt & Bill Scanning (FIXED)

The PDF upload issue from v6.5 had three root causes — all fixed in v4:

- **A.** PDF.js worker URL on cdnjs was rate-limited from `.vercel.app` domains. We now use jsdelivr as primary, cdnjs as fallback, unpkg as tertiary.
- **B.** Rendering a page at scale 2.0× produced 2-4 MB JPEG base64 → JSON body exceeded Vercel's 4.5 MB serverless body limit → HTTP 413. We now **adaptively scale down** (2.0→1.5→1.2→1.0→0.8) × quality (0.85→0.75→0.65→0.55) until the encoded payload is under 3 MB.
- **C.** On `*.github.io`, the cross-origin call to the Vercel app was failing without a clear error. We now do an **OPTIONS preflight** with a 3.5s timeout and gracefully fall back to `/api/ai` if vision-scan is unreachable.

### 3. AI Scan on Subscriptions tab

The 📸 AI Scan button is now in both:
- **Monthly Expenses** → "+ Add Expense" modal (existing)
- **🔔 Subscriptions** → "+ Add Subscription / Bill" modal (NEW)

The subscription scanner does extra magic:
- **Detects existing subscriptions** by vendor fingerprint → suggests "this updates Dialog Mobile Bill from May"
- **Maps expense categories to subscription categories** (Telecom→Telecom, Netflix→Streaming, Insurance→Insurance, etc.)
- **Infers billing cycle** from bill text (monthly/quarterly/yearly)
- **Extracts due day-of-month** from the date

### 4. Recurring Bill Intelligence

When you scan a Dialog phone bill in June and the same bill in July, the system:
- ✅ Recognises it as a recurring bill via vendor fingerprinting
- ✅ Reuses the same description and recurring flag from the prior entry
- ✅ Re-detects the **category** each scan (Dialog could be phone bill OR broadband bill)
- ✅ Updates the amount fresh each time

### 5. Universal-Knowledge AI Advisor

The AI no longer refuses non-finance questions. Ask about history, philosophy, life advice, jokes — anything. It still steers back to finance if YOU bring it up.

### 6. Beautiful PIN-Gated Memory Reset

The "Reset AI Memory" button (in Settings → AI Intelligence) now:
- Opens a beautiful glassmorphism modal (no more native `confirm()`)
- Requires the 6-digit master PIN to proceed
- Wipes local AI history + persona + cloud Firestore record
- Animated dot input with proper haptic feedback

### 7. Universal Scanner Settings

A new **⚙️ AI Scanner Settings** section in Settings → AI Intelligence lets you pick:
- **Quick** (1 engine, ~2s)
- **Deep** (3-5 engines voting, ~4s, default)
- **Ultra** (10+ engines + OCR, ~8s)
- **Frontier** (Gemini 3.1 Pro + Claude 3.5 + 12 more, ~14s)

Plus toggle TensorFlow.js image enhancement and console debug.

---

## 🔧 Environment Variables

Set in your Vercel project → Settings → Environment Variables. Only `WealthFlow_API_Key` is required; the rest are optional and unlock more engines.

```
# REQUIRED — Google Gemini (free tier from aistudio.google.com)
WealthFlow_API_Key=AIza...

# Optional but recommended for redundancy:
OLLAMA_API_KEY=ollama-key-here          # has embedded fallback
GROQ_API_KEY=gsk_...                     # console.groq.com
OCR_SPACE_API_KEY=K8...                  # ocr.space/ocrapi

# New in v6.7 (all FREE tiers):
GITHUB_MODELS_TOKEN=ghp_...              # https://github.com/marketplace/models — GPT-4o FREE
TOGETHER_API_KEY=...                     # api.together.ai
NVIDIA_API_KEY=nvapi-...                 # build.nvidia.com
SAMBANOVA_API_KEY=...                    # cloud.sambanova.ai
FIREWORKS_API_KEY=fw_...                 # fireworks.ai
HUGGINGFACE_API_KEY=hf_...               # huggingface.co/settings/tokens
CEREBRAS_API_KEY=csk-...                 # cloud.cerebras.ai
OPENROUTER_API_KEY=sk-or-...             # openrouter.ai
MISTRAL_API_KEY=...                      # console.mistral.ai
COHERE_API_KEY=...                       # dashboard.cohere.com
DEEPSEEK_API_KEY=sk-...                  # platform.deepseek.com

# Premium (paid):
ANTHROPIC_API_KEY=sk-ant-...             # console.anthropic.com  (Claude 3.5 Sonnet)
XAI_API_KEY=xai-...                      # console.x.ai          (Grok 2 Vision)

# Existing infra:
SMTP_HOST=...                             # for OTP emails
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
OTP_SECRET=...
ADOBE_CLIENT_ID=...                       # for PDF Share
ADOBE_CLIENT_SECRET=...
```

---

## 📂 File Structure

```
/
├── index.html                 ← Main app (922 KB single-file PWA)
├── wealthflow-ai-v4.js        ← Runtime monkey-patch (v4 — 68 KB)
├── wealthflow-scanner.js      ← Multi-engine client orchestrator
├── api/
│   ├── ai.js                  ← Multi-provider failover AI router
│   ├── vision-scan.js         ← 18-engine vision consensus (v3.0)
│   ├── adobe-pdf-share.js
│   ├── send-otp.js
│   ├── verify-otp.js
│   ├── shorten.js
│   └── share-upload.js
├── sw.js                      ← Service worker
├── manifest.json              ← PWA manifest
├── vercel.json                ← Routing + headers
├── package.json               ← v6.7.0
└── README.md
```

---

## 🏗 Architecture

The v4 module is a **runtime monkey-patch**, not a rewrite of index.html. This is intentional:

- ✅ **Zero risk** to the 17,500-line battle-tested core
- ✅ **Rollback in 30 seconds** — just remove the `<script src="/wealthflow-ai-v4.js">` line
- ✅ **Version-controlled** — v4 file is small enough to inspect easily
- ✅ **Side-by-side coexistence** with old logic — only patches the specific functions

The module replaces these globals at load time:
- `window.handleAIScan` — the universal scanner (expense / subscription / chat)
- `window.clearAIChat` — chat-only clear (keeps memory)
- `window.confirmResetAIMemory` — beautiful PIN-gated memory wipe
- `window.buildSystemPrompt` — wrapped to add language + universal-knowledge directives

---

## 🧪 Local Development

```bash
npm install
npm run dev          # vercel dev — serves on http://localhost:3000
npm run deploy       # vercel --prod
```

For testing the v4 module without deploying:
```bash
node test-v4.cjs     # runs browser-shim tests
```

---

## 🔬 Diagnostics

The v4 module exposes a debug object at `window.WF_AI_V4`:

```javascript
// Open browser console at https://wealthflow-personal.vercel.app
WF_AI_V4.version                      // "WF-AI-v4.0"
WF_AI_V4.utils.normaliseAmount("Rs. 1,250.50")  // 1250.5
WF_AI_V4.utils.findMatchingPriorExpense("Dialog Axiata PLC")
WF_AI_V4.openSettings()               // opens scanner settings modal
```

---

## 🏆 Why "Best Website of the Year" Quality?

- **18 AI engines** including 2026's frontier models (Gemini 3.1 Pro, GPT-4o, Claude 3.5 Sonnet)
- **Multi-engine consensus voting** — engines vote on each field independently
- **Adaptive PDF rendering** — auto-scales image down to fit serverless body limits
- **TensorFlow.js GPU preprocessing** — sharpens text before sending to AI
- **Cross-device sync** via Firebase Firestore
- **Universal scanner** — expenses, subscriptions, chat attachments all from one pipeline
- **70+ language AI advisor** with natural human-like speech
- **PIN-gated destructive actions** with beautiful modals
- **Smart recurring-bill detection** — knows Dialog this month is the same as Dialog last month
- **Production-grade error handling** — graceful fallback at every layer
- **Privacy-first** — PIN unlock, auto-lock, sessions tracking

---

## 📜 License

UNLICENSED — Private. © 2026 WealthFlow Elite.
