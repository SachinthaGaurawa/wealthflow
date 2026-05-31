# 🧠 WealthFlow v7.11.0 — Intelligence Layer + Screenshot Reading

This release makes WealthFlow work like a robot: paste text **or attach
screenshots**, walk away, and the AI files everything on its own — learning as
it goes, removing duplicates, encrypting your data, and asking you only about
the rare things it genuinely can’t be sure of (and remembering those questions
until you answer them, even across sessions).

-----

## What’s new at a glance

|Capability                 |Module                                          |What it does                                                                                   |
|---------------------------|------------------------------------------------|-----------------------------------------------------------------------------------------------|
|🖼️ **Read screenshots**     |`wealthflow-vision-sms.js` + `api/vision-sms.js`|Attach 1 or many bank-SMS screenshots; on-device OCR reads them, the same brain classifies them|
|🧠 **Learns merchants**     |`wealthflow-ai-memory.js`                       |Confirm a shop once → remembered forever; branch suffixes collapse                             |
|🔒 **Encrypts data**        |`wealthflow-crypto.js`                          |AES-256-GCM at rest + in cloud sync for all new stores                                         |
|🛡 **Removes duplicates**   |`wealthflow-dedup.js`                           |Multi-signal (amount+day+merchant+card); never deletes on a weak match                         |
|🛟 **Asks later, remembers**|`wealthflow-review.js`                          |Unsure items persist across sessions; prompts on return; teaches memory on resolve             |
|⚡ **Works in background**  |`wealthflow-queue.js`                           |Hand it work, close the app; live progress bar; resumes after reload                           |

-----

## 🖼️ Reading screenshots (the new headline feature)

1. Open **Settings → 📲 Paste Bank SMS → Open**
1. Tap **🖼️ Attach screenshots** (or drag-drop, or paste an image)
1. Pick **one or many** screenshots of your bank-SMS thread
1. The AI reads them on-device and fills the box with the extracted SMS text
1. Tap **⚡ Auto-file** — done. Close the app; the AI keeps working.

**How the OCR works (two tiers):**

- **On-device first** — Tesseract.js runs in your browser. The image never
  leaves your device. Clean digital screenshots (high-contrast text) are the
  ideal case for OCR, so accuracy is excellent and it works offline.
- **Server-vision fallback** — only if the on-device read comes up short *and*
  a Gemini key (`WealthFlow_API_Key`) is configured, the image is sent to
  `/api/vision-sms` which transcribes the text verbatim. If no key is set, the
  app simply keeps the on-device result. Either way, **classification stays in
  the deterministic brain**, so behaviour is identical to pasted text.

Tested on a real DFCC Alerts screenshot containing Cargills Food City, KOKO
Colombo, Serandib Technologies, and an Inward CEFT Transfer → all 4 read and
parsed; the 3 known merchants auto-filed at 98%, the ambiguous transfer routed
to review.

-----

## 🧠 How the “robot” decides

For every transaction (typed, pasted, or read from a screenshot):

```
   classify (brain, 250+ merchant DB)
        │
   learned-memory boost  ← if you've confirmed this shop before, near-certain
        │
   duplicate defence     ← amount+day+merchant+card; certain dup → skip
        │
   confidence ≥ 95% ? ──► AUTO-FILE into the right tab + month + year
        │                 (and learn the merchant→category)
        └─ unsure ──────► REVIEW QUEUE (asked later; never guessed)
```

Confident things are filed instantly and silently. Only genuine unknowns ever
reach you — and they wait patiently (encrypted) until you decide, even if you
close the app and come back the next day.

-----

## 🔒 A note on encryption (honest scope)

The new intelligence stores (learned memory, review queue, job queue) are
encrypted with **AES-256-GCM**; the key is derived on-device (PBKDF2, 210k
iterations) from a per-install random seed, optionally mixed with your Master
PIN. This means a leaked **cloud backup** or **sync blob** is opaque ciphertext.

It is *client-side encryption at rest*, not a zero-knowledge password scheme —
someone with full access to your **unlocked device** could read the key. For
the realistic personal-finance threats (a leaked cloud copy, a shared sync
account, a stolen database) this is strong protection. The app’s older data
stores remain as they were; only the new intelligence stores are encrypted here.

-----

## Files added in v7.11.0

```
wealthflow-crypto.js        client-side AES-256-GCM layer
wealthflow-ai-memory.js     self-learning merchant→category memory
wealthflow-dedup.js         multi-signal duplicate defence
wealthflow-review.js        persistent ask-me-later queue
wealthflow-queue.js         autonomous background engine + progress bar
wealthflow-vision-sms.js    screenshot OCR (Tesseract.js primary)
api/vision-sms.js           optional server-vision transcription fallback
```

All load in dependency order in `index.html` and are served via `vercel.json`.
No new required environment variables. `/api/vision-sms` reuses the existing
`WealthFlow_API_Key`; without it, on-device OCR still works.

-----

© 2026 WealthFlow Elite. UNLICENSED.