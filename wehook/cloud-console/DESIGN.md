# Lonely Warrior Cloud — Design Contract

## Product register

This is a Chinese-language operational product, not a marketing site. It has two related surfaces:

- `admin.lonely-warrior.online`: operator control room for tenants, WeCom installations, customer-service messages, AI suggestions, credits and audit.
- `account.lonely-warrior.online`: customer administrator centre for balance, devices and connection status.

The cloud message console is the service-provider work surface for WeCom conversations and AI-assisted replies. Customer master data, orders, PDFs and knowledge bases may remain in the customer's local system. Copy must state this split accurately and must not claim that chat text never enters the cloud.

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
- Secrets are masked by default and are never shown in a toast or URL. The operator shop configuration modal is an explicit user-requested exception: plaintext inputs with right-edge copy buttons; only newly entered AppSecret is visible, never fetched from storage. Closing or session expiry clears the modal.
- AI replies remain drafts until an operator explicitly sends them during the test phase.
- At narrow widths the sidebar becomes a compact header and tables scroll inside their own labelled region.

## Content voice

Use direct, calm Simplified Chinese. State what the system knows and the next action. Avoid claims such as “secure forever” or “zero risk”. Distinguish “额度” from money and “测试接入” from production readiness.

Shop rows separate the neutral “断开连接” from an outlined danger “删除店铺”. Disconnect affects only the selected shop and preserves records. Delete uses the shared consequential modal, names its scope, requires the complete shop name and keeps focus on Cancel initially. Do not introduce a second modal/toast system or imply that deleting registration switches the external shop service mode.

## 2026-10-10 模型余额管理

用户已取消套餐发放，复用 credits 导航但标题为“模型余额”。客户表提供直接调整余额，弹窗复用 shared modal/form primitives，支持小数、内联错误与提交防重；保留历史充值、余额调整、成本和毛利账单。客户余额变动以远端为准，本地每分钟同步。验收记录位于根 docs/changes/2026-10-10-ai-balance.md。

### 账单账号选择
客户余额表复用现有按钮新增“查看账单”；所选客户名称出现在账单标题，不增加另一套表格/弹窗。初始为空提示选择账号，沿用每页20条分页和既有加载、重试状态。每账号保留300条，累计财务指标不受日志淘汰影响。

### 客户模型Key
在客户余额行复用操作按钮与共享Modal/Form。Key仅在生成成功窗口展示一次，提供复制，状态文字禁止重复生成，通知与列表不含完整密钥。
