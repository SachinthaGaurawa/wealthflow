---
name: WealthFlow Premium FinTech
description: A calm, evidence-led financial operating system with a secure dark interface and restrained gold and emerald signals.
colors:
  midnight-canvas: "#050911"
  raised-ink: "#09111d"
  panel-ink: "#0d1726"
  primary-text: "#f4f7fb"
  secondary-text: "#c9d2df"
  muted-text: "#8491a5"
  wealth-gold: "#e7bd55"
  soft-gold: "#f2d784"
  verified-emerald: "#3dd3a4"
  risk-crimson: "#fb7185"
  focus-gold: "#ffd66b"
typography:
  display:
    fontFamily: "Inter, Geist, sans-serif"
    fontSize: "clamp(50px, 8vw, 110px)"
    fontWeight: 800
    lineHeight: 0.91
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Inter, Geist, sans-serif"
    fontSize: "clamp(23px, 4vw, 32px)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Inter, Geist, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "0.055em"
rounded:
  control: "12px"
  card: "16px"
  shell: "18px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "28px"
  xl: "44px"
components:
  button-primary:
    backgroundColor: "{colors.wealth-gold}"
    textColor: "{colors.midnight-canvas}"
    rounded: "{rounded.control}"
    padding: "12px 18px"
    height: "52px"
  button-ghost:
    backgroundColor: "{colors.raised-ink}"
    textColor: "{colors.secondary-text}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  card:
    backgroundColor: "{colors.panel-ink}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.card}"
    padding: "28px"
---

# Design System: WealthFlow Premium FinTech

## Overview

**Creative North Star: "The Trusted Financial Instrument"**

WealthFlow should feel like a precise financial instrument rather than a decorative dashboard. The system uses a deep midnight field, high-contrast information, quiet glass layers, and rare gold or emerald signals to communicate trust, control, and verified progress.

The interface is dense enough for serious financial work but never visually frantic. Marketing, the secure application, and tenant statements share one material language while preserving distinct information density and bundle boundaries.

**Key Characteristics:**

- Evidence-led hierarchy with figures and status before ornament.
- Dark tonal layering, crisp hairlines, and restrained translucency.
- Gold for decisive action, emerald for verified success, crimson for risk.
- Responsive layouts that collapse into touch-safe single-column flows.

## Colors

The palette is a cool midnight neutral system with narrowly assigned financial accents.

### Primary

- **Wealth Gold** (`#e7bd55`): Primary calls to action and the most important selected state.
- **Soft Gold** (`#f2d784`): High-value labels and supporting emphasis where full gold is too strong.

### Secondary

- **Verified Emerald** (`#3dd3a4`): Successful synchronization, verified records, and positive financial state.
- **Risk Crimson** (`#fb7185`): Overdue, destructive, or error states only.

### Neutral

- **Midnight Canvas** (`#050911`): Page and shell background.
- **Raised Ink** (`#09111d`): Navigation and reduced-transparency fallback.
- **Panel Ink** (`#0d1726`): Cards and elevated content regions.
- **Primary Text** (`#f4f7fb`): Figures, headings, and essential instructions.
- **Secondary Text** (`#c9d2df`): Supporting copy and secondary actions.
- **Muted Text** (`#8491a5`): Metadata and noncritical labels.

### Named Rules

**The One Decisive Accent Rule.** Gold identifies the primary action or active destination; it must not become background decoration across the screen.

**The Semantic Signal Rule.** Emerald and crimson communicate real system or financial state, never mood.

## Typography

**Display Font:** Inter with Geist and sans-serif fallbacks  
**Body Font:** Inter with Geist and sans-serif fallbacks  
**Label/Mono Font:** SFMono-Regular with Consolas fallback for machine state and compact figures

**Character:** A compact, modern grotesk hierarchy keeps dense financial information legible. Tabular figures and tight display tracking make totals easy to compare without making the interface feel like a spreadsheet.

### Hierarchy

- **Display** (800, `clamp(50px, 8vw, 110px)`, 0.91): Marketing promise only.
- **Headline** (800, `clamp(23px, 4vw, 32px)`, 1.15): Page and statement titles.
- **Title** (700–800, 18–28px): Module and record headings.
- **Body** (400–650, 14–18px, 1.55–1.7): Instructions and financial context, generally capped near 70 characters.
- **Label** (700–750, 12px, 0.055em): Compact metadata and table labels, often uppercase.

### Named Rules

**The Figure First Rule.** Financial values use tabular numerals, strong weight, and direct labels; decorative text effects are not part of the system.

## Layout

The marketing surface uses a wide editorial composition with a dominant promise and a three-part signal rail. The secure application uses a persistent 248px desktop rail, a restrained top bar, and a bottom navigation dock below 768px. Tenant statements use a centered 1120px container, fluid card grids, and a one-column reading path on narrow screens.

Spacing follows an 8/12/18/28/44px rhythm. Desktop content may spread horizontally for comparison; mobile content prioritizes a single reading order and minimum 44px touch targets. Data tables must remain readable at 320px without page-level horizontal overflow.

## Elevation & Depth

Depth comes from tonal layers, translucent panels, and neutral ambient shadows. Backdrop blur is progressive enhancement and always has an opaque reduced-transparency fallback.

### Shadow Vocabulary

- **Panel Ambient** (`0 14px 38px rgba(0,0,0,.2)`): Low separation for dashboard and shell panels.
- **Tenant Card** (`0 18px 42px rgba(0,0,0,.22)`): Additional separation for secure statement records.
- **Auth Modal** (`0 28px 56px rgba(0,0,0,.42)`): Reserved for blocking authentication and release-note surfaces.

### Named Rules

**The Tonal Before Shadow Rule.** Use background tone and a single hairline before adding elevation; colored glow is not a general surface treatment.

## Shapes

Controls use 12px corners, content cards use 16px, and major shell surfaces use 18–24px. Pill geometry is reserved for compact status chips and singular actions. Borders are one-pixel translucent separators; they describe structure without becoming decorative side rails.

## Components

### Buttons

- **Shape:** 12px for in-app controls; pill geometry for marketing CTA and compact language control.
- **Primary:** Wealth Gold with midnight text, 12–18px horizontal padding, strong weight.
- **Hover / Focus:** Subtle brightness or neutral elevation; a 3px visible gold focus outline; active state moves by 1px.
- **Secondary / Ghost:** Transparent or raised-ink fill with a clear hairline and secondary text.

### Chips

- **Style:** Compact pill with a translucent neutral field and 12px label.
- **State:** Emerald for verified/settled, crimson for overdue/error, neutral for reference identifiers.

### Cards / Containers

- **Corner Style:** 16px by default.
- **Background:** Panel Ink or an equivalent translucent tonal layer.
- **Shadow Strategy:** Neutral ambient shadow only where tonal separation is insufficient.
- **Border:** One-pixel semantic-neutral hairline.
- **Internal Padding:** 18–32px, responsive to viewport.

### Inputs / Fields

- **Style:** 54px minimum height, 12px radius, quiet translucent fill, strong text contrast.
- **Focus:** Gold 3px outline and a clearer border; no layout shift.
- **Error / Disabled:** Crimson border for invalid state; reduced opacity and no elevation for disabled state.

### Navigation

Desktop navigation uses a persistent dark rail and clear active state. Mobile navigation becomes a five-destination bottom dock with safe-area spacing, visible labels, and touch targets of at least 44px.

### Financial Record

Tenant records combine a semantic status chip, tabular figures, concise facts, and a contained transaction table. Status is communicated by text and color together, never by color alone.

## Do's and Don'ts

### Do:

- **Do** keep gold rare and attached to the primary action or active destination.
- **Do** provide reduced-motion, reduced-transparency, forced-color, keyboard-focus, and narrow-screen behavior.
- **Do** keep financial figures tabular, explicit, and traceable to a labeled record.
- **Do** use SVG brand assets and semantic icons instead of emoji or placeholder glyphs.

### Don't:

- **Don't** use gradient text, decorative pulse indicators, or colored glow as proof of activity.
- **Don't** create cards inside cards when spacing or a divider can express hierarchy.
- **Don't** place body copy below 14px; 12px is reserved for labels and metadata.
- **Don't** let glass effects reduce contrast or become required for comprehension.
