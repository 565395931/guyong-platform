# Lonely Warrior Cloud — Design Contract

## Product register

This is a Chinese-language operational product, not a marketing site. It has two related surfaces:

- `admin.lonely-warrior.online`: operator control room for tenants, WeCom installations, credits and audit.
- `account.lonely-warrior.online`: customer administrator centre for balance, devices and connection status.

The local Electron customer-service application remains the work surface for conversations, customers, PDFs and knowledge bases. The cloud surfaces must never imply that this business data is stored centrally.

## Visual direction

The signature visual is the **signal rail**: a thin vertical topology line with square nodes used to communicate cloud-to-local connection state. The interface should feel like a calm network operations desk—porcelain work surfaces, ink text, teal live signals and amber attention states. Avoid AI-purple gradients, oversized marketing cards, excessive rounding and decorative glass effects.

## Runtime token ownership

This document defines intent. `public/assets/cloud.css` is the canonical runtime owner of the values below. Every screen consumes the same CSS custom properties; no screen-local colour system is allowed.

| Role | Token | Value |
|---|---|---|
| Canvas | `--canvas` | `#f3f1eb` |
| Surface | `--surface` | `#fffdf8` |
| Ink | `--ink` | `#17211f` |
| Muted ink | `--muted` | `#66706d` |
| Border | `--line` | `#d8ddd8` |
| Brand/live | `--signal` | `#087f68` |
| Brand dark | `--signal-strong` | `#075f51` |
| Attention | `--warning` | `#b96b16` |
| Danger | `--danger` | `#b83d35` |
| Informational | `--info` | `#315d82` |

Typography uses local system fonts only: `Microsoft YaHei`, `PingFang SC`, `Segoe UI`, sans-serif. Identifiers and amounts use `Cascadia Mono`, `SFMono-Regular`, monospace. This avoids late font swaps and keeps Chinese text crisp.

Spacing is based on 4px. Controls are 40px high; compact table rows are 48px. Corners are restrained (`6px`, `10px`, `14px`). Shadows are reserved for modal layers and floating status, never for every panel.

## Interaction and accessibility

- WCAG 2.2 AA contrast and visible `:focus-visible` rings.
- Native buttons and links for actions/navigation; no clickable generic containers.
- Motion is subtle (120–180ms) and disabled under `prefers-reduced-motion`.
- The global scrollbar baseline is defined once in `cloud.css`.
- Status never relies on colour alone: dot + text + accessible label.
- Secrets are masked by default and are never shown in a toast or URL.
- At narrow widths the sidebar becomes a compact header and tables scroll inside their own labelled region.

## Content voice

Use direct, calm Simplified Chinese. State what the system knows and the next action. Avoid claims such as “secure forever” or “zero risk”. Distinguish “额度” from money and “测试接入” from production readiness.
