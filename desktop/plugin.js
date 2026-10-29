/**
 * provider-balances — Hermes desktop plugin.
 *
 * A compact status-bar indicator (sits just before Radio at `statusBar.right`
 * order 9) that shows remaining credits per connected provider as a small
 * progress ring + percentage, with a click-to-open popover listing every
 * provider as a full circular gauge (remaining %, reset time, or amount).
 *
 * Data comes from this plugin's own backend namespace via
 *   GET /api/plugins/provider-balances/balances
 *   → { providers: [{ id, display, status, detail, …gauge fields }] }
 *
 * Each provider row is a SUPERSET — the four core fields are always present,
 * the rest are optional and only tighten the readout:
 *
 *   id                 string   stable slug (fallback label)
 *   display            string   human provider name
 *   status             string   'ok' | 'warn' | 'unavailable' | 'error' | …
 *   detail             string   human balance line ("$12.40 left", "2h 15m left")
 *
 *   remaining_percent  number|null  0..100; authoritative when present
 *   remaining          number|null  remaining amount (provider units)
 *   total              number|null  known allowance/total (denominator)
 *   resets_at          string|null  ISO-8601 or epoch-ms; when the window resets
 *   resets_in          string|null  pre-rendered phrase, e.g. "in 3h 12m"
 *
 * Honesty rules (never invent a balance or a percentage):
 *   • remaining_percent set → ring at that %. 0 means DEPLETED (red), distinct
 *     from "unknown" (no ring fill, a dash).
 *   • else remaining + total (finite, total > 0, remaining ≤ total) → computed %.
 *   • else amount only (detail, no total) → show the amount, ring stays
 *     "unknown", no percentage is fabricated.
 *   • else → "Unavailable".
 *
 * Plain ESM, loaded uncompiled — UI is `jsx()` calls, not JSX syntax.
 * Only these imports resolve: @hermes/plugin-sdk, react, react/jsx-runtime.
 */

import {
  atom,
  Badge,
  Button,
  GlyphSpinner,
  host,
  icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  STATUSBAR_AREAS,
  Tip,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'provider-balances'

// How often to refresh balances in the background (never poll faster than a
// few seconds; balances move slowly).
const REFRESH_MS = 60_000

// Disk plugins are not scanned by Tailwind, so the layout lives here and uses
// only theme variables (never hardcoded colors) so it reskins with the app.
// Ring colors use the app's own semantic palette (--ui-green/yellow/orange/red
// and --ui-accent), matching the StatusDot "good/warn/bad" language.
const CSS = `
.pb-chip{display:flex;align-items:center;gap:4px;height:100%;max-width:200px;color:var(--ui-text-tertiary)}
.pb-chip:hover{color:var(--ui-text-primary)}
.pb-chip-icon{display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--ui-text-quaternary)}
.pb-chip[data-state=percent] .pb-chip-icon{color:var(--ui-accent)}
.pb-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.pb-chip[data-state=percent] .pb-chip-text{color:var(--ui-text-secondary)}
.pb-chip[data-state=none] .pb-chip-text{color:var(--ui-text-quaternary)}
.pb-chip-count{flex-shrink:0}
.pb-chip-prov{flex-shrink:0;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--ui-text-quaternary)}
.pb-chip[data-state=percent] .pb-chip-prov{color:var(--ui-text-tertiary)}
.pb-chip[data-low-balance=true]{background:color-mix(in srgb,var(--ui-red) 18%,transparent);outline:1px solid var(--ui-red);color:var(--ui-red)}
.pb-chip[data-low-balance=true] .pb-chip-text,.pb-chip[data-low-balance=true] .pb-chip-prov{color:var(--ui-red);font-weight:700}
.pb-ring{position:relative;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.pb-ring-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.pb-ring-track{stroke:var(--ui-stroke-secondary)}
.pb-ring[data-tone=empty] .pb-ring-track{stroke:color-mix(in srgb, var(--ui-red) 45%, transparent)}
.pb-ring-fill{stroke:var(--pb-color);stroke-linecap:round;transition:stroke-dashoffset .35s ease,stroke .35s ease}
.pb-ring-value{position:relative;font-size:10px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ui-text-primary)}
.pb-ring[data-tone=empty] .pb-ring-value{color:var(--ui-red)}
.pb-ring[data-tone=unknown] .pb-ring-value{color:var(--ui-text-quaternary)}
.pb-panel{width:288px;max-width:calc(100vw - 24px);display:flex;flex-direction:column;overflow:hidden}
.pb-header{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px 2px}
.pb-title{font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--ui-text-secondary)}
.pb-refresh{width:20px;height:20px;flex-shrink:0}
.pb-list{display:flex;flex-direction:column;gap:1px;padding:2px 4px 4px}
.pb-row{display:flex;align-items:center;gap:10px;padding:7px 6px;border-radius:6px}
.pb-row:hover{background:var(--chrome-action-hover)}
.pb-row-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.pb-row-name{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:17px;font-weight:500;color:var(--ui-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-row-main{font-size:11px;line-height:16px;color:var(--ui-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.pb-row-main[data-none=true]{color:var(--ui-text-quaternary)}
.pb-row-sub{font-size:10px;line-height:14px;color:var(--ui-text-quaternary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-row-sub[data-tone=empty]{color:var(--ui-red)}
.pb-row-sub[data-tone=critical]{color:var(--ui-orange)}
.pb-body{display:flex;align-items:center;justify-content:center;gap:6px;padding:16px 8px;font-size:12px;color:var(--ui-text-tertiary)}
.pb-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 10px;font-size:11px;line-height:16px;color:var(--ui-text-secondary);text-align:center}
.pb-footer{padding:4px 8px 6px;font-size:10px;line-height:14px;color:var(--ui-text-quaternary);border-top:1px solid var(--ui-stroke-secondary)}
`

function toNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clamp100(v) {
  return Math.max(0, Math.min(100, v))
}

function detailString(p) {
  const d = p?.detail
  if (typeof d === 'string') return d.trim()
  if (d && typeof d === 'object') {
    const text = (typeof d.text === 'string' && d.text.trim()) || (typeof d.label === 'string' && d.label.trim()) || ''
    return text
  }
  return ''
}

// "in 3h 12m" from an ISO-8601 / epoch-ms reset, computed locally when the
// backend only supplies a timestamp.
function formatResetsAt(value) {
  if (value == null || value === '') return null
  let ms
  if (typeof value === 'number') ms = value
  else {
    const text = String(value).trim()
    const n = Number(text)
    if (Number.isFinite(n) && /^\d+$/.test(text)) ms = n
    else {
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return null
      ms = d.getTime()
    }
  }
  const diff = ms - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  if (hours < 24) return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d ${hours % 24}h`
}

function resetPhrase(p) {
  const rin = p?.resets_in
  if (typeof rin === 'string' && rin.trim()) return rin.trim()
  return formatResetsAt(p?.reset_at ?? p?.resets_at)
}

function isUnavailableStatus(p) {
  const s = String(p?.status ?? '').toLowerCase().trim()
  return ['error', 'bad', 'failed', 'unavailable', 'unsupported', 'none', 'disabled', 'no_account', 'not_supported', 'missing', 'not_configured'].includes(s)
}

// Resolve one provider into a presentable gauge, without ever inventing data.
function resolveGauge(p) {
  const unavailable = isUnavailableStatus(p)
  const text = detailString(p)
  let pct = null
  if (!unavailable) {
    const explicit = toNum(p?.pct_remaining ?? p?.remaining_percent)
    if (explicit != null) {
      pct = clamp100(explicit)
    } else {
      const rem = toNum(p?.remaining)
      const tot = toNum(p?.total)
      if (rem != null && tot != null && tot > 0 && rem <= tot) pct = clamp100((rem / tot) * 100)
    }
  }
  const reset = resetPhrase(p)
  if (pct != null) return { kind: 'percent', pct, text, reset }
  if (text && !unavailable) return { kind: 'amount', pct: null, text, reset }
  return { kind: 'none', pct: null, text, reset: null }
}

// Ring color + center label from a percentage. `null` = unknown (hollow ring,
// a dash), 0 = depleted (red) — the two must never look the same.
function gaugeTone(pct) {
  if (pct == null) return { tone: 'unknown', color: 'var(--ui-stroke-secondary)', label: '–' }
  const p = clamp100(pct)
  if (p <= 0) return { tone: 'empty', color: 'var(--ui-red)', label: '0%' }
  if (p < 5) return { tone: 'critical', color: 'var(--ui-red)', label: `${Math.round(p)}%` }
  if (p < 25) return { tone: 'critical', color: 'var(--ui-orange)', label: `${Math.round(p)}%` }
  if (p < 50) return { tone: 'low', color: 'var(--ui-yellow)', label: `${Math.round(p)}%` }
  return { tone: 'ok', color: 'var(--ui-accent)', label: `${Math.round(p)}%` }
}

async function fetchBalances(ctx) {
  const data = await ctx.rest('/balances', { timeoutMs: 80000 })
  if (!data || !Array.isArray(data.providers)) throw new Error('unexpected-balances-shape')
  return data.providers.filter(p => p && typeof p === 'object')
}

function summarize(providers) {
  return providers.map(p => ({ p, gauge: resolveGauge(p) }))
}

function displayName(p) {
  const d = typeof p.display === 'string' ? p.display.trim() : ''
  return d || (typeof p.id === 'string' ? p.id.trim() : '') || 'Provider'
}

// The popover lists all providers; the chip uses the selected session's provider.
const SHORT_LABELS = { deepseek: 'DeepSeek', anthropic: 'Anthropic', openrouter: 'OpenRouter', 'openai-codex': 'Codex' }

function providerSlug(p) {
  return String(p?.id ?? '').split(':')[0].trim().toLowerCase()
}

function shortProviderName(p) {
  const slug = providerSlug(p)
  return SHORT_LABELS[slug] || displayName(p)
}

// Prefer the current session window, never substitute a weekly quota for it.
// Credit-only providers have a balance rather than session windows.
function rowForProvider(rows, slug) {
  if (!slug) return null
  const own = rows.filter(r => providerSlug(r.p) === slug)
  const session = own.find(r => /^(current-)?session$/.test(String(r.p.id ?? '').split(':')[1] ?? ''))
  if (session) return session
  return own.find(r => !String(r.p.id ?? '').includes(':') && r.gauge.kind === 'amount') ?? null
}

function providerCount(rows) {
  return new Set(rows.map(r => providerSlug(r.p)).filter(Boolean)).size
}

const RING_STROKE = 3.5

function Ring({ tone, color, pct, size = 40, label = null }) {
  const stroke = size <= 20 ? 2.5 : RING_STROKE
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const off = pct == null ? c : c * (1 - clamp100(pct) / 100)
  return jsxs('span', {
    className: 'pb-ring',
    'data-tone': tone,
    style: { width: `${size}px`, height: `${size}px`, '--pb-color': color },
    children: [
      jsxs('svg', { className: 'pb-ring-svg', viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true, children: [
        jsx('circle', { className: 'pb-ring-track', cx: size / 2, cy: size / 2, r, fill: 'none', strokeWidth: stroke }),
        jsx('circle', {
          className: 'pb-ring-fill', cx: size / 2, cy: size / 2, r, fill: 'none', strokeWidth: stroke,
          strokeDasharray: c, strokeDashoffset: off, strokeLinecap: 'round',
          transform: `rotate(-90 ${size / 2} ${size / 2})`
        })
      ] }),
      label != null && jsx('span', { className: 'pb-ring-value', children: label })
    ]
  })
}

function rowMainText(r, t) {
  const g = r.gauge
  if (g.kind === 'percent') return g.text || `${Math.round(g.pct)}% remaining`
  if (g.kind === 'amount') return g.text
  return g.text || t('unavailable') // 'none' with an error note, else "Unavailable"
}

function rowSubText(r, t) {
  const g = r.gauge
  if (g.kind === 'percent') {
    if (g.reset) return (g.reset.startsWith('resets') || g.reset.startsWith('Resets') ? g.reset : `resets ${g.reset}`)
    return g.pct <= 0 ? t('depleted') : t('resetsUnknown')
  }
  if (g.kind === 'amount') return g.reset ? `resets ${g.reset}` : t('totalUnknown')
  return null
}

function BalanceRow({ r, active }) {
  const t = usePluginI18n(ID)
  const g = r.gauge
  const tone = gaugeTone(g.pct)
  const main = rowMainText(r, t)
  const sub = rowSubText(r, t)
  const none = g.kind === 'none'
  const subTone = g.kind === 'percent' && g.pct <= 0 ? 'empty' : tone.tone

  return jsxs('div', { className: 'pb-row', children: [
    jsx(Ring, { tone: tone.tone, color: tone.color, pct: g.pct, size: 40, label: tone.label }),
    jsxs('div', { className: 'pb-row-copy', children: [
      jsxs('span', { className: 'pb-row-name', children: [
        displayName(r.p),
        active && jsx(Badge, { variant: 'solid', size: 'xs', children: t('active') })
      ] }),
      jsx('span', { className: 'pb-row-main', 'data-none': none, children: main }),
      sub && jsx('span', { className: 'pb-row-sub', 'data-tone': subTone, children: sub })
    ] })
  ] })
}

function BalancesList({ query, rows, activeSlug }) {
  const t = usePluginI18n(ID)
  const refetching = query.isFetching && !query.isLoading

  return jsxs('div', { children: [
    jsxs('div', { className: 'pb-header', children: [
      jsx('span', { className: 'pb-title', children: t('title') }),
      jsx(Tip, { label: t('refresh'), children: jsx(Button, {
        variant: 'ghost', size: 'icon-xs', className: 'pb-refresh', 'aria-label': t('refresh'),
        onClick: () => query.refetch(), children: jsx(icons.RefreshCw, { size: 13 })
      }) })
    ] }),
    query.isLoading && jsx('div', { className: 'pb-body', role: 'status', children: [
      jsx(GlyphSpinner, { ariaLabel: t('loading') }),
      jsx('span', { children: t('loading') })
    ] }),
    query.isError && !query.isLoading && jsx('div', { className: 'pb-error', children: [
      jsx('span', { children: t('loadError') }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => query.refetch(), children: t('retry') })
    ] }),
    !query.isLoading && !query.isError && rows.length === 0 && jsx('div', { className: 'pb-body', children: t('noProviders') }),
    !query.isLoading && !query.isError && rows.length > 0 && jsx('div', { className: 'pb-list', children:
      rows.map(r => jsx(BalanceRow, { r, active: providerSlug(r.p) === activeSlug }, r.p.id ?? displayName(r.p))) }),
    jsx('div', { className: 'pb-footer', children: refetching ? t('refreshing') : t('footer') })
  ] })
}

function BalancesBar({ ctx, open }) {
  const t = usePluginI18n(ID)
  const isOpen = useValue(open)
  const liveModel = useValue(host.state.model)
  const sessionId = useValue(host.state.focusedSessionId)
  const owner = useValue(host.state.focusedSessionOwner)
  const sessionProfile = useValue(host.state.focusedSessionProfile)
  const gatewayProfile = useValue(host.state.profile)
  const scopeReady = Boolean(sessionId && owner?.connectionId && owner?.profile === sessionProfile && sessionProfile === gatewayProfile)
  const query = useQuery({
    queryKey: [ID, 'balances', owner?.connectionId, sessionProfile, sessionId],
    enabled: scopeReady,
    queryFn: () => fetchBalances(ctx),
    staleTime: 30_000,
    refetchInterval: REFRESH_MS,
    retry: 2,
    retryDelay: 3_000
  })
  // The gateway knows the selected (provider, model) pair. Model names alone
  // cannot identify the billing provider: GPT or Claude can run on OpenRouter,
  // Codex, or another endpoint. Do not reuse an old answer after a switch.
  const providerQuery = useQuery({
    queryKey: [ID, 'session-provider', owner?.connectionId, sessionId, sessionProfile, liveModel],
    enabled: scopeReady,
    staleTime: 0,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => host.request('model.options', { session_id: sessionId, profile: sessionProfile })
  })

  const rows = summarize(scopeReady ? (query.data ?? []) : [])
  const selected = providerQuery.data
  const matchesModel = liveModel && typeof selected?.model === 'string' &&
    selected.model.trim().toLowerCase() === String(liveModel).trim().toLowerCase()
  const activeSlug = scopeReady && matchesModel && typeof selected?.provider === 'string'
    ? selected.provider.trim().toLowerCase() || null : null
  // Never display a different provider while the current selection is unknown.
  const shown = rowForProvider(rows, activeSlug)
  const provName = shown
    ? shortProviderName(shown.p)
    : (activeSlug ? SHORT_LABELS[activeSlug] || activeSlug : '')
  const extra = Math.max(0, providerCount(rows) - (shown ? 1 : 0))
  const countBadge = extra > 0
    ? jsx('span', { className: 'pb-chip-count', children: jsx(Badge, { variant: 'solid', size: 'xs', children: `+${extra}` }) })
    : null
  const provLabel = provName ? jsx('span', { className: 'pb-chip-prov', children: provName }) : null
  const cardIcon = jsx('span', { className: 'pb-chip-icon', 'aria-hidden': true, children: jsx(icons.CreditCard, { size: 13 }) })

  const tooltip = rows.length
    ? rows.map(r => {
        const g = r.gauge
        if (g.kind === 'percent') return `${displayName(r.p)}: ${Math.round(g.pct)}% left${g.reset ? ` · resets ${g.reset}` : ''}`
        if (g.kind === 'amount') return `${displayName(r.p)}: ${g.text}`
        return `${displayName(r.p)}: ${t('unavailable')}`
      }).join('  ·  ')
    : t('noProviders')

  let state = 'none'
  let chipText = '–'
  let chipInner
  if (query.isLoading) {
    state = 'loading'
    chipText = t('loading')
    chipInner = [jsx('span', { className: 'pb-chip-icon', children: jsx(GlyphSpinner, { ariaLabel: t('loading') }) })]
  } else if (shown && shown.gauge.kind === 'percent') {
    const tone = gaugeTone(shown.gauge.pct)
    state = 'percent'
    chipText = tone.label
    chipInner = [
      jsx(Ring, { tone: tone.tone, color: tone.color, pct: shown.gauge.pct, size: 16 }),
      provLabel,
      jsx('span', { className: 'pb-chip-text', children: tone.label }),
      countBadge
    ]
  } else if (shown && shown.gauge.kind === 'amount') {
    state = 'amount'
    chipText = shown.gauge.text
    chipInner = [
      cardIcon,
      provLabel,
      jsx('span', { className: 'pb-chip-text', children: shown.gauge.text }),
      countBadge
    ]
  } else {
    state = 'none'
    chipText = provName ? `${provName} — ${t('unavailable')}` : t('unavailable')
    chipInner = [cardIcon, provLabel, jsx('span', { className: 'pb-chip-text', children: '–' })]
  }

  return jsx(Tip, { label: tooltip, children:
    jsxs(Popover, { open: isOpen, onOpenChange: v => open.set(v), children: [
      jsx(PopoverTrigger, { asChild: true, children: jsx(Button, {
        variant: 'ghost', size: 'micro', className: 'pb-chip', 'data-state': state,
        'data-low-balance': shown?.gauge.kind === 'percent' && shown.gauge.pct < 5 ? true : undefined,
        'aria-label': `${t('title')} — ${chipText}`, children: chipInner
      }) }),
      jsx(PopoverContent, { side: 'top', align: 'end', className: 'pb-panel', 'aria-label': t('title'), children:
        jsx(BalancesList, { query, rows, activeSlug }) })
    ] })
  })
}

export default {
  id: ID,
  name: 'Provider Balances',
  description: 'Remaining credits per connected provider as rings and percentages, beside the radio in the status bar.',
  register(ctx) {
    ctx.i18n.register({
      en: {
        title: 'Provider balances',
        unavailable: 'Unavailable',
        depleted: 'Depleted',
        resetsUnknown: 'resets unknown',
        totalUnknown: 'total unknown',
        loading: 'Loading…',
        loadError: "Couldn't load provider balances",
        retry: 'Try again',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        noProviders: 'No providers connected',
        footer: 'Reported by the provider-balances backend',
        active: 'active'
      },
      ru: {
        title: 'Балансы провайдеров',
        unavailable: 'Недоступно',
        depleted: 'Исчерпано',
        resetsUnknown: 'сброс неизвестен',
        totalUnknown: 'лимит неизвестен',
        loading: 'Загрузка…',
        loadError: 'Не удалось получить балансы провайдеров',
        retry: 'Повторить',
        refresh: 'Обновить',
        refreshing: 'Обновление…',
        noProviders: 'Нет подключённых провайдеров',
        footer: 'Данные бэкенда provider-balances',
        active: 'текущий'
      }
    })

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    const open = atom(false)

    ctx.register({
      id: 'balances',
      area: STATUSBAR_AREAS.right,
      order: 9,
      render: () => jsx(BalancesBar, { ctx, open })
    })
  }
}
