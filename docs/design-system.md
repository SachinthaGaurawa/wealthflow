# WealthFlow design system

One set of tokens, one logo, one font. The app, the customer portal, a printed
statement and any public page load the same files, so they cannot drift apart.

## Files

| File | What it is | Who loads it |
| --- | --- | --- |
| `wf-tokens.css` | Colour, type, space, radius, motion and layer tokens plus the self-hosted Geist `@font-face`. No element selectors: loading it changes nothing by itself. | Every surface |
| `wf-ui.css` | The app's skin (sidebar, top bar, cards, tables, forms, modals, tab bar, command palette). App only. | `index.html` |
| `wealthflow-shell.js` | Phone tab bar, "More" sheet, Ctrl/Cmd+K command palette. Reads the sidebar as the one list of screens; writes no data. | `index.html` |
| `assets/fonts/geist-*.woff2` | Geist and Geist Mono (SIL OFL 1.1, see `assets/fonts/OFL.txt`). Served from our own origin so they work under `font-src 'self'`. | via `wf-tokens.css` |
| `assets/wf-mark.svg` | The logo mark as one vector (gold ring, green arrow, dark face). | Any surface; in the app it is also inlined as the `#wf-mark` sprite |

## Adopting the tokens on another surface

```html
<link rel="stylesheet" href="/wf-tokens.css">
<html data-theme-auto>   <!-- follow the device; or set data-theme="dark|light" yourself -->
```

Then use `var(--wf-*)` instead of hex codes:

- Surfaces: `--wf-bg`, `--wf-surface`, `--wf-card`, `--wf-card-2`, `--wf-card-3`
- Lines: `--wf-line`, `--wf-line-2`, `--wf-line-3` (a form control's edge, 3:1)
- Text: `--wf-text`, `--wf-text-2`, `--wf-text-3` (all AA on every surface they are used on)
- Accent (the logo's gold): `--wf-accent`, `--wf-accent-fill`, `--wf-accent-ink`, `--wf-accent-soft`
- Money: `--wf-pos` (in), `--wf-neg` (out); never decorative
- Type: `--wf-font`, `--wf-font-mono`, `--wf-fs-*`; use `font-variant-numeric: tabular-nums` for amounts
- Space on a 4-pt grid `--wf-s1 … --wf-s12`, radius `--wf-r-*`, motion `--wf-dur-*` / `--wf-ease`

Sinhala is not in Geist; the stack falls through to Noto Sans Sinhala.

## The NEW tag (`wealthflow-new-badge.js`)

A screen or an option that is new wears a small gold NEW pill for exactly 7 days, then it goes away by itself. Nothing is written by hand to turn it on or off.

- **A new screen** (a new entry in the sidebar, i.e. a `showPage('x', this)` id that is not in the script's `BASELINE`) is picked up automatically: the first time a device sees it, it is stamped and tagged for 7 days. Do not add it to `BASELINE`.
- **A new option, button or card** (Settings or anywhere else): put `data-wf-new="YYYY-MM-DD"` (the day it ships, UTC) on the element. The script appends the pill and removes it 7 days after that date, on every device alike.
- The pill never counts as "needs attention" (the red dot on More) and never changes the element's own text; the phone More sheet shows it on the tile.
- Run `npx vitest run test/new_badge_test.js` and `node test/e2e/new-badge.mjs`.

## Rules the tests enforce

- Text contrast is at least 4.5:1 on every surface, in both themes; form edges 3:1.
- Touch targets are at least 44 px on coarse pointers.
- No screen scrolls sideways at 360, 390, 768 or 1280 px, in either theme.
- No emoji glyphs in shipped files (the interface draws its own icons).
- Every dynamic string put into markup by the shell is escaped.

Run `npx vitest run test/design_system_test.js` and `node test/e2e/ui-shell.mjs`.
