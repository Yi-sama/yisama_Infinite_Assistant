// Kept self-contained because this function is serialized into Codex through CDP.
export function installAssistantUI(options = {}) {
  const ROOT_ID = 'yisama-infinite-assistant-ui'
  const topFrame = (() => {
    try { return window.top === window } catch { return false }
  })()
  if (!topFrame || (window.location.href !== 'app://-/index.html' && options.allowTestLocation !== true)) return null

  const existing = window.__yisamaInfiniteAssistant
  if (existing?.receive && document.getElementById(ROOT_ID)) return existing
  existing?.dispose?.()

  const cleanups = []
  const pending = new Map()
  const storageKey = 'yisama-infinite-assistant-ui-position-v1'
  const state = {
    open: false,
    loggedIn: false,
    configured: false,
    username: '',
    quota: '',
    group: '',
    groupLabel: '',
    groups: [],
    model: '',
    models: [],
    message: '',
    restartRequired: false,
    setupPending: false,
    staleQuota: false,
    pendingGroup: '',
    error: '',
    authReady: false,
    authMode: 'login',
    registrationEnabled: false,
    passwordLoginEnabled: false,
    emailVerificationEnabled: false,
    loginId: '',
    verificationRetryAt: 0,
    nativeSync: '',
  }
  let disposed = false
  let sequence = 0
  let foregroundVersion = 0
  let latestStatusId = 0
  let dragging = null
  let suppressClick = false

  const safe = (fn, fallback) => { try { return fn() } catch { return fallback } }
  const addListener = (node, event, listener, options) => {
    node.addEventListener(event, listener, options)
    cleanups.push(() => node.removeEventListener(event, listener, options))
  }
  const el = (tag, attributes = {}, content = null) => {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined) continue
      if (name === 'className') node.className = value
      else if (name === 'text') node.textContent = value
      else node.setAttribute(name, String(value))
    }
    if (content !== null) node.textContent = content
    return node
  }
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
  const timeoutFor = (action) => {
    const override = options.requestTimeouts?.[action]
    if (Number.isFinite(override) && override > 0) return override
    if (action === 'status') return 90 * 1000
    return 120 * 1000
  }
  const cleanText = (value, maximum = 240) => typeof value === 'string' ? value.slice(0, maximum) : ''
  const selectValues = (values, mapper) => Array.isArray(values) ? values.map(mapper).filter(Boolean) : []

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const svg = (viewBox, paths, className) => {
    const node = document.createElementNS(SVG_NS, 'svg')
    node.setAttribute('viewBox', viewBox)
    node.setAttribute('aria-hidden', 'true')
    node.setAttribute('focusable', 'false')
    if (className) node.setAttribute('class', className)
    for (const attributes of paths) {
      const path = document.createElementNS(SVG_NS, attributes.tag || 'path')
      for (const [name, value] of Object.entries(attributes)) if (name !== 'tag') path.setAttribute(name, value)
      node.appendChild(path)
    }
    return node
  }
  // The site's mark: two crescents around a four-point star. While requests run, the crescents orbit.
  const brandMark = (className) => svg('0 0 24 24', [
    { tag: 'g', class: 'y-mark__orbit' },
    { d: 'M12 9.2Q12.5 11.5 14.8 12 12.5 12.5 12 14.8 11.5 12.5 9.2 12 11.5 11.5 12 9.2Z', class: 'y-mark__star' },
  ], `y-mark ${className}`)
  const fillMark = (node) => {
    const orbit = node.querySelector('.y-mark__orbit')
    for (const [d, fill] of [
      ['M11.4 2.02A10 10 0 0 0 11.4 21.98 5.2 5.2 0 0 0 9.6 13.6 4.6 4.6 0 0 1 11.4 2.02Z', 'url(#yisama-grad-cool)'],
      ['M12.6 21.98A10 10 0 0 0 12.6 2.02 5.2 5.2 0 0 0 14.4 10.4 4.6 4.6 0 0 1 12.6 21.98Z', 'url(#yisama-grad-warm)'],
    ]) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      path.setAttribute('fill', fill)
      orbit.appendChild(path)
    }
    return node
  }
  const defs = svg('0 0 0 0', [], 'y-defs')
  defs.innerHTML = '<defs>'
    + '<linearGradient id="yisama-grad-cool" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#20d8f0"/><stop offset="1" stop-color="#8a4ff0"/></linearGradient>'
    + '<linearGradient id="yisama-grad-warm" x1="1" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#ff7ab8"/><stop offset="1" stop-color="#e050c8"/></linearGradient>'
    + '<linearGradient id="yisama-grad-star" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#20c0e0"/><stop offset="1" stop-color="#8060e0"/></linearGradient>'
    + '</defs>'

  const root = el('div', { id: ROOT_ID, className: 'yisama-assistant-ui' })
  const style = el('style')
  const R = `#${ROOT_ID}`
  const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .55 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`
  // Always dark: the panel is a small piece of api.yisama.asia, using that site's own tokens.
  style.textContent = `
    ${R}{--y-bg:#07070b;--y-bg2:#0d0d13;--y-bg3:#15151e;--y-line:rgba(255,255,255,.08);--y-line2:rgba(255,255,255,.14);--y-fg:#f3efe8;--y-fg2:rgba(243,239,232,.66);--y-fg3:rgba(243,239,232,.42);--y-mag:#e060c0;--y-vio:#8060e0;--y-cyan:#20c0e0;--y-grad:linear-gradient(100deg,#e060c0 0%,#8060e0 48%,#20c0e0 100%);--y-amber:#f2b45c;--y-red:#ff8a7a;--y-ease:cubic-bezier(.16,1,.3,1);--y-sans:"Inter Tight","Noto Sans SC","PingFang SC","Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;--y-mono:"JetBrains Mono",ui-monospace,"Cascadia Mono",Consolas,monospace;position:fixed;inset:0;z-index:2147483000;pointer-events:none;color:var(--y-fg);font:13px/1.45 var(--y-sans);-webkit-font-smoothing:antialiased;color-scheme:dark}
    ${R} *{box-sizing:border-box}
    ${R} [hidden]{display:none!important}
    ${R} button,${R} input{font:inherit;color:inherit}
    ${R} button{margin:0;border:0;background:none;cursor:pointer}
    ${R} button:disabled{cursor:not-allowed}
    ${R} :focus-visible{outline:2px solid var(--y-cyan);outline-offset:2px}
    ${R} .y-defs{position:absolute;width:0;height:0}
    ${R} .y-mark{display:block;flex:0 0 auto;overflow:visible}
    ${R} .y-mark__orbit{transform-origin:12px 12px}
    ${R} .y-mark__star{fill:url(#yisama-grad-star);transform-origin:12px 12px}
    ${R} [data-busy="true"] .y-mark__orbit{animation:y-orbit 1.6s var(--y-ease) infinite}
    ${R} [data-busy="true"] .y-mark__star{animation:y-twinkle 1.6s ease-in-out infinite}
    @keyframes y-orbit{to{transform:rotate(360deg)}}
    @keyframes y-twinkle{50%{transform:scale(1.7) rotate(45deg);fill:#fff}}
    ${R} .y-grad-text{background:var(--y-grad);-webkit-background-clip:text;background-clip:text;color:transparent}

    ${R} .yisama-badge{position:fixed;display:inline-flex;align-items:center;gap:7px;max-width:min(128px,calc(100vw - 16px));height:32px;padding:0 12px 0 7px;border:1px solid transparent;border-radius:99px;background:linear-gradient(var(--y-bg2),var(--y-bg2)) padding-box,linear-gradient(var(--y-line2),var(--y-line2)) border-box;color:var(--y-fg);box-shadow:0 10px 30px -12px rgba(0,0,0,.7),0 0 0 1px rgba(0,0,0,.25);font:600 12px/1 var(--y-mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em;pointer-events:auto;touch-action:none;user-select:none;-webkit-app-region:no-drag;transition:transform .3s var(--y-ease),box-shadow .3s var(--y-ease),background .3s}
    ${R} .yisama-badge:hover,${R} .yisama-badge[aria-expanded="true"]{background:linear-gradient(var(--y-bg2),var(--y-bg2)) padding-box,var(--y-grad) border-box;box-shadow:0 12px 34px -10px rgba(224,96,192,.55),0 0 0 1px rgba(0,0,0,.25)}
    ${R} .yisama-badge:hover{transform:translateY(-1px)}
    ${R} .yisama-badge .y-mark{width:19px;height:19px}
    ${R} .yisama-badge .y-mark path[fill]{stroke:var(--y-bg2);stroke-width:1.1}
    ${R} .yisama-badge[data-stale="true"]{color:var(--y-amber)}
    ${R} .yisama-badge__text{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    ${R} .yisama-badge__stale{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--y-amber);box-shadow:0 0 8px var(--y-amber)}

    ${R} .yisama-panel{position:fixed;display:flex;width:min(320px,calc(100vw - 16px));flex-direction:column;border:1px solid var(--y-line2);border-radius:22px;background:radial-gradient(120% 60% at 85% -10%,rgba(128,96,224,.28),transparent 60%),radial-gradient(90% 50% at 0% 0%,rgba(224,96,192,.16),transparent 55%),var(--y-bg2);box-shadow:0 40px 80px -24px rgba(0,0,0,.8),0 30px 60px -30px rgba(224,96,192,.35),inset 0 1px 0 rgba(255,255,255,.06);pointer-events:auto;overflow:hidden;isolation:isolate;-webkit-app-region:no-drag}
    ${R} .yisama-panel:before{position:absolute;inset:0;z-index:-1;background-image:${GRAIN};opacity:.07;mix-blend-mode:overlay;pointer-events:none;content:""}
    ${R} .yisama-panel:after{position:absolute;top:0;left:22px;right:22px;height:1px;background:var(--y-grad);opacity:.85;box-shadow:0 0 18px 1px rgba(224,96,192,.6);content:""}
    ${R} .y-head{display:flex;align-items:center;gap:9px;height:52px;padding:0 10px 0 16px;flex:0 0 auto}
    ${R} .y-head .y-mark{width:24px;height:24px}
    ${R} .y-head .y-mark path[fill]{stroke:var(--y-bg2);stroke-width:1}
    ${R} .y-wordmark{display:flex;align-items:baseline;gap:7px;min-width:0;flex:1 1 auto;white-space:nowrap;overflow:hidden}
    ${R} .y-wordmark strong{font-weight:750;font-size:15px;letter-spacing:-.02em}
    ${R} .y-wordmark small{color:var(--y-fg3);font:500 10px/1 var(--y-mono);letter-spacing:.08em;text-transform:uppercase}
    ${R} .y-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:99px;color:var(--y-fg3);transition:background .2s,color .2s,transform .4s var(--y-ease)}
    ${R} .y-icon:hover:not(:disabled){background:rgba(255,255,255,.06);color:var(--y-fg)}
    ${R} .y-icon:disabled{opacity:.35}
    ${R} .y-icon[data-testid="refresh"]:active:not(:disabled){transform:rotate(-120deg)}
    ${R} .y-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    ${R} .y-body{min-height:0;flex:1 1 auto;overflow:auto;padding:4px 16px 16px;scrollbar-width:thin;scrollbar-color:var(--y-line2) transparent}

    ${R} .y-meter{padding:4px 2px 18px}
    ${R} .y-kicker{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--y-fg3);font:500 10px/1.4 var(--y-mono);letter-spacing:.1em;text-transform:uppercase}
    ${R} .y-kicker strong{min-width:0;overflow:hidden;color:var(--y-fg2);font-weight:500;letter-spacing:0;text-transform:none;text-overflow:ellipsis;white-space:nowrap}
    ${R} .y-meter__value{display:flex;align-items:flex-end;gap:10px;min-width:0;margin-top:6px}
    ${R} .y-balance{display:block;min-width:0;overflow:hidden;padding-bottom:2px;font:800 42px/1.05 var(--y-sans);font-variant-numeric:tabular-nums;letter-spacing:-.045em;white-space:nowrap;background:linear-gradient(100deg,#e060c0 0%,#8060e0 24%,#20c0e0 50%,#e060c0 75%,#8060e0 100%) 0 0/200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 6px 22px rgba(224,96,192,.28))}
    ${R} .y-balance[data-long="true"]{font-size:22px;letter-spacing:-.02em}
        ${R} .y-meter__value small{flex:0 0 auto;margin-bottom:8px;padding:2px 7px;border:1px solid rgba(242,180,92,.35);border-radius:99px;color:var(--y-amber);font:600 10px/1.4 var(--y-mono)}
    ${R} .y-status{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--y-fg2);font-size:12px}
    ${R} .y-pill{flex:0 0 auto;padding:2px 8px;border-radius:99px;background:var(--y-grad);color:#fff;font:700 10px/1.4 var(--y-sans);letter-spacing:.04em}
    ${R} .y-status[data-kind="busy"] .y-pill{background-size:200% 100%;animation:y-flow 1.2s linear infinite}
    ${R} .y-status[data-kind="warning"] .y-pill{background:rgba(242,180,92,.16);color:var(--y-amber);box-shadow:inset 0 0 0 1px rgba(242,180,92,.35)}
    ${R} .y-status[data-kind="off"] .y-pill{background:rgba(255,255,255,.08);color:var(--y-fg3)}
    @keyframes y-flow{to{background-position:-200% 0}}

    ${R} .y-section-label{display:flex;align-items:baseline;justify-content:space-between;margin:2px 2px 8px;color:var(--y-fg3);font:500 10px/1.4 var(--y-mono);letter-spacing:.1em;text-transform:uppercase}
    ${R} .y-section-hint{letter-spacing:0;text-transform:none}
    ${R} .y-groups{position:relative;max-height:216px;overflow:auto;overscroll-behavior:contain;border-top:1px solid var(--y-line);border-bottom:1px solid var(--y-line);scrollbar-width:thin;scrollbar-color:var(--y-line2) transparent}
    ${R} .y-groups[data-edge="top"]{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 28px),transparent)}
    ${R} .y-groups[data-edge="middle"]{-webkit-mask-image:linear-gradient(to bottom,transparent,#000 28px,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to bottom,transparent,#000 28px,#000 calc(100% - 28px),transparent)}
    ${R} .y-groups[data-edge="bottom"]{-webkit-mask-image:linear-gradient(to bottom,transparent,#000 28px);mask-image:linear-gradient(to bottom,transparent,#000 28px)}
    ${R} .y-groups__track{position:relative;display:grid;gap:2px;padding:4px 0}
    ${R} .y-groups__empty{padding:14px 10px 14px 30px;color:var(--y-fg3);font-size:12px}
    ${R} .y-search{position:relative;margin-bottom:8px}
    ${R} .y-search svg{position:absolute;top:50%;left:11px;width:14px;height:14px;margin-top:-7px;fill:none;stroke:var(--y-fg3);stroke-width:1.8;stroke-linecap:round;pointer-events:none}
    ${R} .y-search input{width:100%;height:34px;padding:0 12px 0 32px;border:1px solid var(--y-line);border-radius:99px;background:rgba(255,255,255,.03);color:var(--y-fg);font-size:12.5px;transition:border-color .2s,box-shadow .2s}
    ${R} .y-search input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
    ${R} .y-search input::placeholder{color:var(--y-fg3)}
    ${R} .y-search input:focus{outline:none;border-color:var(--y-vio);box-shadow:0 0 0 3px rgba(128,96,224,.22)}
    ${R} .y-groups[aria-disabled="true"]{cursor:progress}
    ${R} .y-rail{position:absolute;top:24px;bottom:24px;left:13px;width:1px;background:repeating-linear-gradient(to bottom,var(--y-line2) 0 3px,transparent 3px 7px);pointer-events:none}
    ${R} .y-trail{position:absolute;left:12px;width:3px;border-radius:3px;background:linear-gradient(to bottom,var(--y-cyan),var(--y-vio),var(--y-mag));opacity:0;box-shadow:0 0 12px rgba(224,96,192,.7);pointer-events:none}
    ${R} .y-comet{position:absolute;top:0;left:7.5px;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff 0 18%,var(--y-mag) 45%,var(--y-vio) 100%);box-shadow:0 0 0 3px rgba(224,96,192,.18),0 0 16px 2px rgba(224,96,192,.75);pointer-events:none;z-index:1}
    ${R} .y-comet:after{position:absolute;inset:-6px;border:1.5px solid var(--y-mag);border-radius:50%;opacity:0;content:""}
    ${R} .y-comet[data-pending="true"]:after{animation:y-sonar 1.1s var(--y-ease) infinite}
    ${R} .y-comet[data-landed="true"]:after{animation:y-sonar .7s var(--y-ease) 1}
    @keyframes y-sonar{0%{opacity:.9;transform:scale(.5)}100%{opacity:0;transform:scale(2.1)}}
    ${R} .y-group{position:relative;display:flex;align-items:center;gap:10px;min-height:38px;padding:0 10px 0 30px;border-radius:12px;text-align:left;color:var(--y-fg2);transition:color .25s,background .25s}
    ${R} .y-group:hover:not(:disabled){background:rgba(255,255,255,.035);color:var(--y-fg)}
    ${R} .y-group[aria-checked="true"]{background:linear-gradient(90deg,rgba(128,96,224,.16),rgba(128,96,224,0) 75%);color:var(--y-fg)}
    ${R} .y-group__node{position:absolute;top:50%;left:10px;width:7px;height:7px;margin-top:-3.5px;border:1px solid var(--y-fg3);border-radius:50%;background:var(--y-bg2);transition:border-color .25s}
    ${R} .y-group:hover .y-group__node{border-color:var(--y-fg2)}
    ${R} .y-group__name{min-width:0;flex:1 1 auto;overflow:hidden;font-weight:550;text-overflow:ellipsis;white-space:nowrap}
    ${R} .y-group[aria-checked="true"] .y-group__name{font-weight:700}
    ${R} .y-group__ratio{flex:0 0 auto;color:var(--y-fg3);font:500 11px/1 var(--y-mono)}
    ${R} .y-group[aria-checked="true"] .y-group__ratio{color:var(--y-fg2)}
    ${R} .y-group__ratio[data-cheap="true"]{color:var(--y-cyan)}
    ${R} .y-group__tag{flex:0 0 auto;font:600 10px/1 var(--y-mono);letter-spacing:.04em}
    ${R} .y-group__tag:empty{display:none}
    ${R} .y-group[data-state="current"] .y-group__tag{color:transparent;background:var(--y-grad);-webkit-background-clip:text;background-clip:text}
    ${R} .y-group[data-state="pending"] .y-group__tag{color:var(--y-fg3);animation:y-blink 1s steps(2) infinite}
    @keyframes y-blink{50%{opacity:.35}}
    ${R} .y-group[data-failed="true"]{animation:y-shake .45s var(--y-ease)}
    @keyframes y-shake{20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}

    ${R} .y-notice{position:relative;margin:12px 0 0;padding:9px 12px 9px 14px;border-radius:12px;background:rgba(255,255,255,.04);color:var(--y-fg2);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
    ${R} .y-notice:before{position:absolute;top:10px;bottom:10px;left:0;width:2px;border-radius:2px;background:var(--y-grad);content:""}
    ${R} .y-notice[data-error="true"]{background:rgba(242,180,92,.08);color:var(--y-amber)}
    ${R} .y-notice[data-error="true"]:before{background:var(--y-amber)}
    ${R} .y-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:0 16px;border-radius:99px;font-weight:650;font-size:13px;transition:transform .2s var(--y-ease),box-shadow .3s var(--y-ease),filter .2s,background .2s}
    ${R} .y-button:active:not(:disabled){transform:scale(.97)}
    ${R} .y-button:disabled{opacity:.45}
    ${R} .y-button--primary{background:var(--y-fg);color:#0a0a0f;box-shadow:0 10px 40px -10px rgba(224,96,192,.55),inset 0 0 0 1px rgba(255,255,255,.2)}
    ${R} .y-button--primary:disabled{opacity:1;background:rgba(255,255,255,.06);color:var(--y-fg3);box-shadow:inset 0 0 0 1px var(--y-line)}
    ${R} .y-button--primary:hover:not(:disabled){box-shadow:0 14px 44px -8px rgba(224,96,192,.75),inset 0 0 0 1px rgba(255,255,255,.2)}
    ${R} .y-button--primary svg{transition:transform .3s var(--y-ease)}
    ${R} .y-button--primary:hover:not(:disabled) svg{transform:translate(2px,-2px)}
    ${R} .y-button--accent{background:var(--y-grad);color:#fff;box-shadow:0 10px 30px -10px rgba(128,96,224,.8)}
    ${R} .y-button--accent:hover:not(:disabled){filter:brightness(1.1)}
    ${R} .y-button--quiet{border:1px solid var(--y-line2);background:rgba(255,255,255,.03);color:var(--y-fg)}
    ${R} .y-button--quiet:hover:not(:disabled){background:rgba(255,255,255,.07)}
    ${R} .y-button--wide{width:100%}
    ${R} .y-button svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    ${R} .y-apply{margin-top:12px}
    ${R} .y-takeover{margin-top:12px}
    ${R} .y-actions{display:grid;gap:6px;margin-top:16px}
    ${R} .y-link{justify-self:center;padding:6px 10px;border-radius:99px;color:var(--y-fg3);font-size:11.5px;transition:color .2s}
    ${R} .y-link:hover:not(:disabled){color:var(--y-red)}
    ${R} .y-confirm{margin-top:14px;padding:14px;border:1px solid rgba(255,138,122,.3);border-radius:16px;background:rgba(255,138,122,.05)}
    ${R} .y-confirm p{margin:0;color:var(--y-fg2);font-size:12px;line-height:1.55}
    ${R} .y-confirm div{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
    ${R} .y-confirm .y-button{min-height:34px;padding:0 14px;font-size:12px}
    ${R} .y-button--danger{background:var(--y-red);color:#1a0806}

    ${R} .y-auth{display:grid;gap:14px;padding-top:6px}
    ${R} .y-auth__intro h2{margin:0;font-size:26px;font-weight:850;letter-spacing:-.03em;line-height:1.15}
    ${R} .y-auth__intro p{margin:6px 0 0;color:var(--y-fg3);font:500 11px/1.4 var(--y-mono)}
    ${R} .y-tabs{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;border:1px solid var(--y-line);border-radius:99px;background:rgba(255,255,255,.025)}
    ${R} .y-tabs:before{position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);border:1px solid rgba(224,96,192,.45);border-radius:99px;background:linear-gradient(100deg,rgba(224,96,192,.32),rgba(128,96,224,.32));content:"";transition:transform .45s var(--y-ease)}
    ${R} .y-tabs[data-mode="register"]:before{transform:translateX(100%)}
    ${R} .y-tabs button{position:relative;min-height:30px;border-radius:99px;color:var(--y-fg3);font-size:12.5px;font-weight:650;transition:color .25s}
    ${R} .y-tabs button[aria-selected="true"]{color:var(--y-fg)}
    ${R} .y-tabs button:disabled:not([aria-selected="true"]){opacity:.5}
    ${R} .yisama-auth-form{display:grid;gap:12px;margin:0}
    ${R} .yisama-auth-form h2{margin:0;font-size:18px;font-weight:800;letter-spacing:-.02em}
    ${R} .yisama-field{display:grid;gap:6px}
    ${R} .yisama-field label{color:var(--y-fg2);font-size:11.5px;font-weight:550}
    ${R} .yisama-auth-form input{width:100%;min-width:0;height:40px;padding:0 13px;border:1px solid var(--y-line2);border-radius:12px;background:rgba(7,7,11,.6);color:var(--y-fg);transition:border-color .2s,box-shadow .2s}
    ${R} .yisama-auth-form input:hover:not(:disabled){border-color:rgba(255,255,255,.22)}
    ${R} .yisama-auth-form input:focus{outline:none;border-color:var(--y-vio);box-shadow:0 0 0 3px rgba(128,96,224,.25)}
    ${R} .yisama-auth-form input:disabled{opacity:.5}
    ${R} .yisama-verification-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
    ${R} .yisama-verification-row .y-button{min-height:40px;padding:0 13px;font-size:12px}
    ${R} .yisama-auth-form .y-button--wide{margin-top:4px}
    @media (max-height:540px){${R} .y-balance{font-size:32px}${R} .y-meter{padding-bottom:12px}${R} .y-group{min-height:34px}}
    @media (prefers-reduced-motion:reduce){${R} *,${R} *:before,${R} *:after{animation:none!important;transition:none!important}}
  `
  root.append(style, defs)

  const badge = el('button', {
    type: 'button', className: 'yisama-badge', 'aria-label': '打开 yisama 无限助手', 'aria-expanded': 'false',
    'data-testid': 'assistant-badge',
  })
  const badgeText = el('span', { className: 'yisama-badge__text', 'data-testid': 'badge-balance' }, '登录')
  const badgeStale = el('span', { className: 'yisama-badge__stale', hidden: '', title: '余额可能已过期', 'aria-label': '余额可能已过期', 'data-testid': 'badge-stale' })
  badge.append(fillMark(brandMark('yisama-badge__mark')), badgeText, badgeStale)

  const panel = el('aside', {
    className: 'yisama-panel', role: 'dialog', 'aria-label': 'yisama 无限助手', 'aria-modal': 'false',
    hidden: '', 'data-testid': 'assistant-panel',
  })
  const header = el('header', { className: 'y-head' })
  const wordmark = el('div', { className: 'y-wordmark' })
  wordmark.append(el('strong', {}, 'YisamaAPI'), el('small', {}, '无限助手'))
  const refreshButton = el('button', {
    type: 'button', className: 'y-icon', title: '刷新账户状态', 'aria-label': '刷新账户状态', 'data-testid': 'refresh',
  })
  refreshButton.append(svg('0 0 24 24', [{ d: 'M20 11a8 8 0 1 0-2.3 5.7' }, { d: 'M20 5v6h-6' }]))
  const closeButton = el('button', {
    type: 'button', className: 'y-icon', title: '关闭', 'aria-label': '关闭', 'data-testid': 'close',
  })
  closeButton.append(svg('0 0 24 24', [{ d: 'M6 6l12 12M18 6L6 18' }]))
  header.append(fillMark(brandMark('y-head__mark')), wordmark, refreshButton, closeButton)

  const content = el('div', { className: 'y-body' })
  const balance = el('section', { className: 'y-meter', 'aria-label': '账户' })
  const meterTop = el('div', { className: 'y-kicker' })
  const account = el('strong', { 'data-testid': 'username', title: '账号' })
  meterTop.append(el('span', {}, 'Balance · 余额'), account)
  const meterValue = el('div', { className: 'y-meter__value' })
  const balanceValue = el('strong', { className: 'y-balance', 'data-testid': 'panel-balance' }, '—')
  const balanceStale = el('small', { hidden: '', 'data-testid': 'stale-note' }, '余额可能已过期')
  meterValue.append(balanceValue, balanceStale)
  const statusLine = el('div', { className: 'y-status', role: 'status', 'data-testid': 'status-line' })
  const statusPill = el('span', { className: 'y-pill', 'aria-hidden': 'true' }, 'LIVE')
  const statusText_ = el('span', {}, '正在读取账户状态')
  statusLine.append(statusPill, statusText_)
  balance.append(meterTop, meterValue, statusLine)

  const fields = el('section', { className: 'y-fields', hidden: '' })
  const groupLabel = el('div', { className: 'y-section-label', id: 'yisama-assistant-group-label' })
  const groupCount = el('span', { className: 'y-section-hint' }, '点选即切换')
  groupLabel.append(el('span', {}, 'Routes · 线路分组'), groupCount)
  const groupSearch = el('label', { className: 'y-search', hidden: '' })
  const groupSearchInput = el('input', { type: 'search', placeholder: '搜索线路', 'aria-label': '搜索线路', 'data-testid': 'group-search', autocomplete: 'off', maxlength: 60 })
  groupSearch.append(svg('0 0 24 24', [{ d: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4' }]), groupSearchInput)
  const groupSelect = el('div', {
    className: 'y-groups', role: 'radiogroup', 'aria-labelledby': 'yisama-assistant-group-label',
    'data-testid': 'group-select', 'data-value': '', 'aria-disabled': 'false',
  })
  const groupRail = el('span', { className: 'y-rail', 'aria-hidden': 'true' })
  const groupTrail = el('span', { className: 'y-trail', 'aria-hidden': 'true' })
  const groupComet = el('span', { className: 'y-comet', 'aria-hidden': 'true', hidden: '' })
  const groupTrack = el('div', { className: 'y-groups__track' })
  const groupEmpty = el('div', { className: 'y-groups__empty', hidden: '' }, '没有匹配的线路')
  groupTrack.append(groupRail, groupTrail, groupComet)
  groupSelect.append(groupTrack, groupEmpty)
  const applyButton = el('button', {
    type: 'button', className: 'y-button y-button--accent y-button--wide y-apply', 'data-testid': 'apply-selection',
  }, '使用此分组')
  const takeoverButton = el('button', {
    type: 'button', className: 'y-button y-button--accent y-button--wide y-takeover', 'data-testid': 'takeover',
  }, '接管 Codex（重启后生效）')
  takeoverButton.append(svg('0 0 24 24', [{ d: 'M5 12h13M13 6l6 6-6 6' }]))
  fields.append(groupLabel, groupSearch, groupSelect, applyButton, takeoverButton)

  const notice = el('div', { className: 'y-notice', role: 'status', hidden: '', 'data-testid': 'message' })

  const actions = el('section', { className: 'y-actions', hidden: '' })
  const rechargeButton = el('button', { type: 'button', className: 'y-button y-button--primary y-button--wide', 'data-testid': 'recharge' }, '充值')
  rechargeButton.append(svg('0 0 24 24', [{ d: 'M8 16L16 8M9 8h7v7' }]))
  const restoreButton = el('button', { type: 'button', className: 'y-link', 'data-testid': 'restore' }, '退出并恢复原配置')
  actions.append(rechargeButton, restoreButton)
  const confirmation = el('section', { className: 'y-confirm', hidden: '', 'data-testid': 'restore-confirmation' })
  const confirmationText = el('p', {}, '退出账户，并把 Codex 配置恢复到使用助手之前的状态？恢复后需要重启 Codex 才会生效。')
  const confirmationActions = el('div')
  const cancelRestore = el('button', { type: 'button', className: 'y-button y-button--quiet', 'data-testid': 'cancel-restore' }, '取消')
  const confirmRestore = el('button', { type: 'button', className: 'y-button y-button--danger', 'data-testid': 'confirm-restore' }, '退出并恢复')
  confirmationActions.append(cancelRestore, confirmRestore)
  confirmation.append(confirmationText, confirmationActions)

  const loggedOut = el('section', { className: 'y-auth', 'data-testid': 'logged-out' })
  const authIntro = el('div', { className: 'y-auth__intro' })
  const authTitle = el('h2')
  authTitle.append(document.createTextNode('一个账号，'), el('br'), el('span', { className: 'y-grad-text' }, '通往所有模型。'))
  authIntro.append(authTitle, el('p', {}, '与 api.yisama.asia 账号互通'))
  const authTabs = el('div', { className: 'y-tabs', role: 'tablist', 'aria-label': '账号', 'data-testid': 'auth-tabs', 'data-mode': 'login' })
  const loginTab = el('button', { type: 'button', role: 'tab', 'aria-selected': 'true', 'data-testid': 'login-tab' }, '登录')
  const registerTab = el('button', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-testid': 'register-tab' }, '注册')
  authTabs.append(loginTab, registerTab)
  const authForm = el('form', { className: 'yisama-auth-form', 'data-testid': 'auth-form' })
  const inputField = (name, label, attributes) => {
    const field = el('div', { className: 'yisama-field' })
    const id = `yisama-auth-${name}`
    const input = el('input', { id, name, 'data-testid': `auth-${name}`, ...attributes })
    field.append(el('label', { for: id }, label), input)
    return { field, input }
  }
  const usernameField = inputField('username', '用户名或邮箱', { type: 'text', autocomplete: 'username', maxlength: 200, required: '' })
  const passwordField = inputField('password', '密码', { type: 'password', autocomplete: 'current-password', maxlength: 1024, required: '' })
  const confirmField = inputField('confirm-password', '确认密码', { type: 'password', autocomplete: 'new-password', maxlength: 20 })
  const emailField = inputField('email', '邮箱', { type: 'email', autocomplete: 'email', maxlength: 254 })
  const verificationField = inputField('verification-code', '邮箱验证码', { type: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6 })
  const verificationRow = el('div', { className: 'yisama-verification-row' })
  const sendVerificationButton = el('button', { type: 'button', className: 'y-button y-button--quiet', 'data-testid': 'send-verification' }, '发送验证码')
  verificationRow.append(verificationField.input, sendVerificationButton)
  verificationField.field.append(verificationRow)
  const loginButton = el('button', { type: 'submit', className: 'y-button y-button--accent y-button--wide', 'data-testid': 'login' }, '登录')
  authForm.append(usernameField.field, passwordField.field, confirmField.field, emailField.field, verificationField.field, loginButton)
  const twoFactorForm = el('form', { className: 'yisama-auth-form', hidden: '', 'data-testid': 'two-factor-form' })
  const twoFactorField = inputField('two-factor', '二次验证码或备用码', { type: 'text', autocomplete: 'one-time-code', maxlength: 100, required: '' })
  const twoFactorButton = el('button', { type: 'submit', className: 'y-button y-button--accent y-button--wide', 'data-testid': 'verify-login' }, '验证并登录')
  const backToLogin = el('button', { type: 'button', className: 'y-button y-button--quiet y-button--wide', 'data-testid': 'back-to-login' }, '返回登录')
  twoFactorForm.append(el('h2', {}, '二次验证'), twoFactorField.field, twoFactorButton, backToLogin)
  loggedOut.append(authIntro, authTabs, authForm, twoFactorForm)
  content.append(balance, fields, notice, confirmation, loggedOut, actions)
  panel.append(header, content)
  root.append(badge, panel)
  document.documentElement.appendChild(root)

  const publicState = (data) => ({
    loggedIn: data?.loggedIn === true,
    configured: data?.configured === true,
    username: cleanText(data?.username, 120),
    quota: cleanText(data?.quota, 80),
    group: cleanText(data?.group, 200),
    groupLabel: cleanText(data?.groupLabel, 200),
    groups: selectValues(data?.groups, (group) => {
      const value = cleanText(group?.value, 200)
      const label = cleanText(group?.label, 200)
      const ratio = typeof group?.ratio === 'number' && Number.isFinite(group.ratio) ? String(group.ratio) : cleanText(group?.ratio, 16)
      return value && label ? { value, label, ratio } : null
    }),
    model: cleanText(data?.model, 200),
    models: selectValues(data?.models, (model) => cleanText(model, 200)),
    message: cleanText(data?.message),
    restartRequired: data?.restartRequired === true,
    setupPending: data?.setupPending === true,
  })
  const quotaLabel = () => state.quota || '—'
  // One place per kind of information: the status line carries the steady state,
  // the notice carries errors and fresh messages, and is hidden when it would repeat the status line.
  const statusText = () => {
    if (state.nativeSync === 'pending' || state.nativeSync === 'syncing') return '正在同步 Codex 模型'
    if (state.nativeSync === 'account-change') return '主实例尚未接管，当前对话未被中断。'
    if (state.nativeSync === 'error') return '配置已保存，Codex 模型尚未同步。'
    if (state.setupPending || hasActivePending('login')) return '登录成功，正在准备配置'
    if (state.pendingGroup) return '正在切换线路'
    if (state.staleQuota) return '余额暂未刷新'
    if (state.loggedIn && state.configured) return '已准备就绪'
    if (state.loggedIn) return '账户已登录，尚未准备配置'
    return '未登录'
  }
  const statusKind = () => {
    if (state.staleQuota || ['error', 'account-change'].includes(state.nativeSync)) return 'warning'
    if (state.setupPending || state.pendingGroup || ['pending', 'syncing'].includes(state.nativeSync)) return 'busy'
    return state.loggedIn && state.configured ? 'normal' : 'off'
  }
  const statusPillText = { normal: 'LIVE', busy: 'SYNC', warning: 'WAIT', off: 'IDLE' }
  const noticeText = () => {
    if (state.error) return state.error
    if (state.nativeSync === 'account-change') {
      return '重启并接管后，可使用当前线路和模型支持的 Ultra、Fast（1.5x 计费）等能力。'
    }
    // Steady-state phrases belong to the status line only; a pending switch makes older messages stale.
    if (!state.message || state.pendingGroup) return ''
    const plain = (text) => text.replace(/[。.]$/, '')
    return ['已准备就绪', '账户已登录', plain(statusText())].includes(plain(state.message)) ? '' : state.message
  }
  const hasActivePending = (action) => [...pending.values()].some((entry) => entry.action === action && !entry.timedOut)
  const hasForegroundPending = () => [...pending.values()].some((entry) => entry.action !== 'status' && !entry.timedOut)
  const reducedMotion = () => safe(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, false)
  const EASE = 'cubic-bezier(.16,1,.3,1)'
  let shownQuota = null
  const setBalance = (text) => {
    if (text === shownQuota) return
    const animate = shownQuota !== null && shownQuota !== '—' && !panel.hidden && !reducedMotion()
    shownQuota = text
    balanceValue.title = text
    balanceValue.dataset.long = String(text.length > 11)
    balanceValue.textContent = text
    // Animate the whole number: per-character layers would escape the gradient text clip.
    if (animate) balanceValue.animate?.([
      { transform: 'translateY(30%)', opacity: 0, filter: 'blur(5px)', backgroundPosition: '100% 0' },
      { transform: 'none', opacity: 1, filter: 'blur(0)', backgroundPosition: '0 0', offset: .55 },
      { backgroundPosition: '-100% 0' },
    ], { duration: 900, easing: EASE })
  }
  let groupKey = ''
  let shownGroup = ''
  let cometY = null
  const groupOptions = () => [...groupTrack.querySelectorAll('.y-group')]
  const SEARCH_AFTER = 7
  const updateEdges = () => {
    const scrollable = groupSelect.scrollHeight > groupSelect.clientHeight + 1
    const atTop = groupSelect.scrollTop <= 1
    const atBottom = groupSelect.scrollTop + groupSelect.clientHeight >= groupSelect.scrollHeight - 1
    groupSelect.dataset.edge = !scrollable ? '' : atTop ? 'top' : atBottom ? 'bottom' : 'middle'
  }
  const applyGroupFilter = () => {
    const query = groupSearch.hidden ? '' : groupSearchInput.value.trim().toLowerCase()
    let visible = 0
    for (const option of groupOptions()) {
      const match = !query || option.title.toLowerCase().includes(query) || option.dataset.value.toLowerCase().includes(query)
      option.hidden = !match
      if (match) visible += 1
    }
    groupEmpty.hidden = visible > 0
    groupRail.hidden = visible < 2
  }
  const ratioText = (ratio) => {
    if (!ratio) return ''
    if (Number(ratio) === 0) return '免费'
    return /^[\d.]+$/.test(ratio) ? `×${ratio}` : ratio
  }
  // A light travels along the route rail from the current stop to the chosen one.
  const moveComet = (target, instant) => {
    groupComet.hidden = false
    const to = `translateY(${target}px)`
    if (instant || cometY === null || reducedMotion()) {
      groupComet.style.transform = to
      cometY = target
      return
    }
    const from = cometY
    if (Math.abs(target - from) < 1) return
    cometY = target
    groupComet.style.transform = to
    const distance = Math.abs(target - from)
    const duration = Math.min(720, 360 + distance * 2)
    groupComet.animate?.([
      { transform: `translateY(${from}px) scale(1)` },
      { transform: `translateY(${(from + target) / 2}px) scale(.8,1.5)`, offset: .5 },
      { transform: `${to} scale(1)` },
    ], { duration, easing: EASE })
    groupTrail.style.top = `${Math.min(from, target)}px`
    groupTrail.style.height = `${distance}px`
    groupTrail.style.transformOrigin = target > from ? 'top' : 'bottom'
    groupTrail.animate?.([
      { opacity: 0, transform: 'scaleY(0)' },
      { opacity: 1, transform: 'scaleY(1)', offset: .55 },
      { opacity: 0, transform: 'scaleY(1)' },
    ], { duration: duration + 260, easing: EASE })
  }
  const renderGroups = (selected, locked) => {
    const key = JSON.stringify(state.groups)
    if (key !== groupKey) {
      groupKey = key
      groupTrack.replaceChildren(groupRail, groupTrail, groupComet)
      for (const group of state.groups) {
        const option = el('button', {
          type: 'button', role: 'radio', className: 'y-group', 'data-value': group.value, title: group.label,
        })
        const ratio = el('span', { className: 'y-group__ratio' }, ratioText(group.ratio))
        ratio.dataset.cheap = String(group.ratio !== '' && Number(group.ratio) < 1)
        option.append(
          el('span', { className: 'y-group__node', 'aria-hidden': 'true' }),
          el('span', { className: 'y-group__name' }, group.label),
          ratio,
          el('span', { className: 'y-group__tag' }),
        )
        groupTrack.appendChild(option)
      }
      cometY = null
    }
    const searchable = state.groups.length > SEARCH_AFTER
    if (groupSearch.hidden === searchable) {
      groupSearch.hidden = !searchable
      if (!searchable) groupSearchInput.value = ''
    }
    groupCount.textContent = searchable ? `共 ${state.groups.length} 条 · 点选即切换` : '点选即切换'
    applyGroupFilter()
    groupSelect.dataset.value = selected || ''
    groupSelect.setAttribute('aria-disabled', String(locked))
    let active = null
    const options = groupOptions()
    for (const option of options) {
      const value = option.dataset.value
      const checked = value === selected
      const syncing = ['pending', 'syncing'].includes(state.nativeSync)
      const stateName = value === state.pendingGroup || (syncing && value === state.group) ? 'pending'
        : value === state.group && state.configured && !['error', 'account-change'].includes(state.nativeSync) ? 'current' : ''
      option.setAttribute('aria-checked', String(checked))
      option.tabIndex = checked || (!selected && option === options[0]) ? 0 : -1
      option.disabled = locked
      option.dataset.state = stateName
      option.lastChild.textContent = stateName === 'pending' ? '切换中' : stateName === 'current' ? '使用中' : ''
      if (checked) active = option
    }
    groupComet.dataset.pending = String(Boolean(state.pendingGroup))
    if (!active || active.hidden || panel.hidden) {
      groupComet.hidden = true
      cometY = null
      if (panel.hidden) { shownGroup = ''; groupSearchInput.value = '' }
      updateEdges()
      return
    }
    if (!shownGroup) groupSelect.scrollTop = Math.max(0, active.offsetTop + active.offsetHeight / 2 - groupSelect.clientHeight / 2)
    moveComet(active.offsetTop + active.offsetHeight / 2 - 6, !shownGroup || cometY === null)
    updateEdges()
    if (shownGroup && shownGroup !== selected && !state.pendingGroup) {
      groupComet.dataset.landed = 'true'
      window.setTimeout(() => { delete groupComet.dataset.landed }, 750)
    }
    if (!state.pendingGroup) shownGroup = selected
  }
  const flagFailedGroup = (value) => {
    const option = groupOptions().find((node) => node.dataset.value === value)
    if (!option) return
    option.dataset.failed = 'true'
    window.setTimeout(() => { delete option.dataset.failed }, 500)
  }
  const placePanel = () => {
    if (panel.hidden) return
    const margin = 8
    const gap = 12
    const anchor = badge.getBoundingClientRect()
    const width = panel.offsetWidth
    const above = anchor.top + anchor.height / 2 > window.innerHeight / 2
    const room = above ? anchor.top - gap - margin : window.innerHeight - anchor.bottom - gap - margin
    panel.style.maxHeight = `${Math.round(Math.max(Math.min(340, window.innerHeight - margin * 2), Math.min(room, window.innerHeight - margin * 2)))}px`
    const height = panel.offsetHeight
    const left = clamp(anchor.right - width, margin, Math.max(margin, window.innerWidth - width - margin))
    const top = clamp(above ? anchor.top - gap - height : anchor.bottom + gap, margin,
      Math.max(margin, window.innerHeight - height - margin))
    panel.style.left = `${Math.round(left)}px`
    panel.style.top = `${Math.round(top)}px`
    panel.style.transformOrigin = `${Math.round(clamp(anchor.left + anchor.width / 2 - left, 0, width))}px ${above ? '100%' : '0'}`
  }
  const render = () => {
    const quota = quotaLabel()
    const busy = hasForegroundPending()
    const badgeLabel = state.loggedIn ? quota : '登录'
    badgeText.textContent = badgeLabel
    badgeText.title = state.loggedIn ? `余额 ${quota}` : '登录'
    badgeStale.hidden = !(state.staleQuota && Boolean(state.quota))
    badge.dataset.stale = String(state.staleQuota && Boolean(state.quota))
    badge.dataset.busy = String(busy || state.setupPending || ['pending', 'syncing'].includes(state.nativeSync))
    badge.setAttribute('aria-label', state.staleQuota && state.quota
      ? `余额 ${badgeLabel}，余额可能已过期。打开 yisama 无限助手`
      : `${state.loggedIn ? '余额 ' : ''}${badgeLabel}。打开 yisama 无限助手`)
    badge.setAttribute('aria-expanded', String(state.open))
    const opening = state.open && panel.hidden
    panel.hidden = !state.open
    header.dataset.busy = String(busy || hasActivePending('status'))
    if (opening) shownQuota = null
    setBalance(quota)
    balance.hidden = !state.loggedIn
    balanceStale.hidden = !(state.staleQuota && Boolean(state.quota))
    const kind = statusKind()
    statusText_.textContent = statusText()
    statusPill.textContent = statusPillText[kind]
    statusLine.dataset.kind = kind
    const message = noticeText()
    notice.textContent = message
    notice.hidden = !message
    notice.dataset.error = String(Boolean(state.error))
    fields.hidden = !state.loggedIn
    actions.hidden = !state.loggedIn
    loggedOut.hidden = state.loggedIn
    confirmation.hidden = confirmation.dataset.open !== 'true' || !state.loggedIn
    restoreButton.hidden = !confirmation.hidden
    if (state.loggedIn) {
      const selectedGroup = state.pendingGroup || state.group
      groupLabel.hidden = !state.groups.length
      groupSelect.hidden = !state.groups.length
      renderGroups(selectedGroup, busy || !state.groups.length)
      const accountMismatch = state.nativeSync === 'account-change' && state.configured
      applyButton.hidden = state.configured
      takeoverButton.hidden = !accountMismatch
      applyButton.textContent = state.groups.length ? '使用此分组' : '重试准备'
      applyButton.disabled = busy || Boolean(state.pendingGroup) || (state.groups.length > 0 && !selectedGroup)
      takeoverButton.disabled = busy || Boolean(state.pendingGroup) || hasActivePending('reconfigure')
      account.textContent = state.username || '—'
      rechargeButton.disabled = busy
      restoreButton.disabled = busy
      confirmRestore.disabled = busy
    }
    refreshButton.disabled = hasActivePending('status')
    const registering = state.authMode === 'register'
    const secondStep = Boolean(state.loginId)
    authIntro.hidden = secondStep
    authTabs.hidden = secondStep
    authTabs.dataset.mode = state.authMode
    authForm.hidden = secondStep
    twoFactorForm.hidden = !secondStep
    loginTab.setAttribute('aria-selected', String(!registering))
    registerTab.setAttribute('aria-selected', String(registering))
    loginTab.disabled = busy
    registerTab.disabled = busy || !state.registrationEnabled
    usernameField.input.maxLength = registering ? 20 : 200
    passwordField.input.maxLength = registering ? 20 : 1024
    passwordField.input.minLength = registering ? 8 : 1
    passwordField.input.autocomplete = registering ? 'new-password' : 'current-password'
    confirmField.field.hidden = !registering
    confirmField.input.required = registering
    const verifyEmail = registering && state.emailVerificationEnabled
    emailField.field.hidden = !verifyEmail
    emailField.input.required = verifyEmail
    verificationField.field.hidden = !verifyEmail
    verificationField.input.required = verifyEmail
    for (const field of [usernameField, passwordField, confirmField, emailField, verificationField, twoFactorField]) {
      field.input.disabled = busy
    }
    loginButton.disabled = busy || !state.authReady || !(registering ? state.registrationEnabled : state.passwordLoginEnabled)
    loginButton.textContent = hasActivePending('login') ? '正在登录…' : hasActivePending('register') ? '正在注册…' : registering ? '注册' : '登录'
    twoFactorButton.disabled = busy
    twoFactorButton.textContent = hasActivePending('login') ? '正在验证…' : '验证并登录'
    backToLogin.disabled = busy
    const retryAfter = Math.max(0, Math.ceil((state.verificationRetryAt - Date.now()) / 1000))
    sendVerificationButton.disabled = busy || retryAfter > 0
    sendVerificationButton.textContent = hasActivePending('sendVerification') ? '正在发送…' : retryAfter ? `${retryAfter}s 后重发` : '发送验证码'
    placePanel()
    if (opening && !reducedMotion()) {
      panel.animate?.([
        { opacity: 0, transform: 'translateY(10px) scale(.92)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'none', filter: 'none' },
      ], { duration: 420, easing: EASE })
      ;[header, ...content.children].filter((node) => !node.hidden).forEach((node, index) => node.animate?.([
        { opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' },
      ], { duration: 520, delay: 60 + index * 45, easing: EASE, fill: 'backwards' }))
    }
  }
  const applyData = (data, preserveDrafts = false) => {
    const next = publicState(data)
    const drafts = { pendingGroup: preserveDrafts ? state.pendingGroup : '' }
    Object.assign(state, next, drafts, { staleQuota: false, error: '' })
    if (!state.loggedIn) confirmation.dataset.open = 'false'
    if (state.loggedIn) {
      clearAuthSecrets()
      state.loginId = ''
    }
  }
  const clearAuthSecrets = () => {
    passwordField.input.value = ''
    confirmField.input.value = ''
    verificationField.input.value = ''
    twoFactorField.input.value = ''
  }
  const failure = (entry, code) => {
    if (entry.action === 'status') {
      state.staleQuota = Boolean(state.quota)
      state.error = '无法刷新账户状态'
    } else if (entry.setup) {
      state.setupPending = false
      state.error = '账户已登录，准备配置未完成，请重试准备。'
    } else if (entry.action === 'login') {
      state.error = '登录未完成，请检查账号、密码或二次验证码。'
    } else if (entry.action === 'register') {
      state.error = '注册未完成，请检查账号、密码和邮箱验证码。'
    } else if (entry.action === 'authOptions') {
      state.error = '无法连接助手登录服务，请稍后刷新。'
    } else if (entry.action === 'sendVerification') {
      state.error = '验证码发送失败，请检查邮箱或稍后重试。'
    } else if (entry.action === 'select') {
      flagFailedGroup(state.pendingGroup)
      state.pendingGroup = ''
      state.error = code === 'GROUP_NO_TEXT_MODEL'
        ? '此分组没有可自动选择的对话模型，原分组未改动。'
        : '切换未完成，原分组未改动，请重试。'
    } else if (entry.action === 'reconfigure') {
      state.error = '接管准备未完成，原配置未改动，请重试。'
    } else {
      state.error = '操作未完成，请稍后重试。'
    }
    const authErrors = {
      AUTH_RATE_LIMIT: '操作过于频繁，请稍后再试。',
      AUTH_UNAVAILABLE: '账号服务暂时不可用，请稍后重试。',
      AUTH_CONNECTION: '暂时无法连接账号服务，请检查网络后重试。',
      AUTH_SESSION_LIMIT: '登录设备过多，请先退出其他设备。',
      AUTH_EXPIRED: '二次验证已过期，请重新输入账号和密码。',
    }
    if (['login', 'register', 'authOptions', 'sendVerification'].includes(entry.action) && authErrors[code]) {
      state.error = authErrors[code]
      if (code === 'AUTH_EXPIRED') state.loginId = ''
    }
    if (['login', 'register'].includes(entry.action)) clearAuthSecrets()
  }
  const settleTimeout = (id) => {
    const entry = pending.get(id)
    if (!entry || disposed) return
    if (entry.action !== 'status') {
      entry.timedOut = true
      if (entry.setup) {
        state.setupPending = false
        state.error = '账户已登录，准备配置等待较久，仍可能完成。'
      } else state.error = '操作仍在等待完成。'
      render()
      return
    }
    pending.delete(id)
    if (entry.id !== latestStatusId || hasForegroundPending() || entry.foregroundVersion !== foregroundVersion) return
    failure(entry)
    render()
  }
  const request = (action, details = {}) => {
    if (disposed || (action === 'status' ? hasActivePending('status') : hasForegroundPending())) return null
    const id = ++sequence
    if (action !== 'status') foregroundVersion += 1
    const command = { id, action }
    if (typeof details.group === 'string' && details.group) command.group = details.group
    const authFields = action === 'login' ? ['username', 'password', 'loginId', 'twoFactorCode']
      : action === 'register' ? ['username', 'password', 'email', 'verificationCode']
        : action === 'sendVerification' ? ['email'] : []
    for (const name of authFields) {
      if (typeof details[name] === 'string' && details[name]) command[name] = details[name]
    }
    if (action === 'select' && command.group) {
      state.pendingGroup = command.group
    }
    state.error = ''
    const entry = {
      id,
      action,
      setup: action === 'login' && !command.username && !command.password && !command.loginId,
      foregroundVersion,
      timer: window.setTimeout(() => settleTimeout(id), timeoutFor(action)),
      timedOut: false,
    }
    pending.set(id, entry)
    if (action === 'status') latestStatusId = id
    render()
    try {
      const result = window.yisamaAssistantCommand?.(JSON.stringify(command))
      result?.catch?.(() => {
        const active = pending.get(id)
        if (!active) return
        pending.delete(id)
        window.clearTimeout(active.timer)
        failure(active)
        if (active.action !== 'status') foregroundVersion += 1
        render()
      })
      if (typeof window.yisamaAssistantCommand !== 'function') throw new Error('bridge unavailable')
    } catch {
      const active = pending.get(id)
      if (active) {
        pending.delete(id)
        window.clearTimeout(active.timer)
        failure(active)
        if (active.action !== 'status') foregroundVersion += 1
        render()
      }
    }
    return id
  }
  const setOpen = (open) => {
    const opening = open && !state.open
    state.open = open
    if (!open) clearAuthSecrets()
    render()
    if (opening) request('status')
    if (open) window.setTimeout(() => closeButton.focus(), 0)
  }
  const storedPosition = safe(() => JSON.parse(window.localStorage.getItem(storageKey) || 'null'), null)
  const defaultPosition = () => ({ left: Math.max(8, window.innerWidth - 138), top: Math.max(8, window.innerHeight - 56) })
  const badgePosition = {
    left: Number.isFinite(storedPosition?.left) ? storedPosition.left : defaultPosition().left,
    top: Number.isFinite(storedPosition?.top) ? storedPosition.top : defaultPosition().top,
  }
  const placeBadge = () => {
    const width = badge.offsetWidth || 120
    const height = badge.offsetHeight || 32
    badgePosition.left = clamp(badgePosition.left, 8, Math.max(8, window.innerWidth - width - 8))
    badgePosition.top = clamp(badgePosition.top, 8, Math.max(8, window.innerHeight - height - 8))
    badge.style.left = `${Math.round(badgePosition.left)}px`
    badge.style.top = `${Math.round(badgePosition.top)}px`
    placePanel()
  }
  const saveBadgePosition = () => safe(() => window.localStorage.setItem(storageKey, JSON.stringify(badgePosition)))

  addListener(badge, 'pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: badgePosition.left, top: badgePosition.top, moved: false }
    badge.setPointerCapture?.(event.pointerId)
  })
  addListener(badge, 'pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return
    const dx = event.clientX - dragging.startX
    const dy = event.clientY - dragging.startY
    if (Math.abs(dx) + Math.abs(dy) > 5) dragging.moved = true
    if (!dragging.moved) return
    badgePosition.left = dragging.left + dx
    badgePosition.top = dragging.top + dy
    placeBadge()
  })
  const finishDrag = (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return
    if (dragging.moved) {
      suppressClick = true
      saveBadgePosition()
      window.setTimeout(() => { suppressClick = false }, 0)
    }
    dragging = null
  }
  addListener(badge, 'pointerup', finishDrag)
  addListener(badge, 'pointercancel', finishDrag)
  addListener(badge, 'click', () => {
    if (suppressClick) return
    setOpen(!state.open)
  })
  addListener(closeButton, 'click', () => setOpen(false))
  addListener(refreshButton, 'click', () => {
    if (state.nativeSync === 'error') delete window.__yisamaNativeModelSync
    request('status')
  })
  const setAuthMode = (mode) => {
    if (hasForegroundPending()) return
    state.authMode = mode
    state.loginId = ''
    state.error = ''
    state.message = ''
    clearAuthSecrets()
    render()
    usernameField.input.focus()
  }
  addListener(loginTab, 'click', () => setAuthMode('login'))
  addListener(registerTab, 'click', () => {
    if (state.registrationEnabled) setAuthMode('register')
  })
  addListener(backToLogin, 'click', () => setAuthMode('login'))
  addListener(authForm, 'submit', (event) => {
    event.preventDefault()
    if (hasForegroundPending() || !state.authReady || !authForm.reportValidity()) return
    const registering = state.authMode === 'register'
    if (!(registering ? state.registrationEnabled : state.passwordLoginEnabled)) return
    if (registering && passwordField.input.value !== confirmField.input.value) {
      state.error = '两次输入的密码不一致。'
      render()
      confirmField.input.focus()
      return
    }
    const details = { username: usernameField.input.value.trim(), password: passwordField.input.value }
    if (registering && state.emailVerificationEnabled) {
      details.email = emailField.input.value.trim()
      details.verificationCode = verificationField.input.value.trim()
    }
    clearAuthSecrets()
    request(registering ? 'register' : 'login', details)
  })
  addListener(twoFactorForm, 'submit', (event) => {
    event.preventDefault()
    if (hasForegroundPending() || !state.loginId || !twoFactorForm.reportValidity()) return
    const details = { loginId: state.loginId, twoFactorCode: twoFactorField.input.value.trim() }
    clearAuthSecrets()
    request('login', details)
  })
  addListener(sendVerificationButton, 'click', () => {
    if (hasForegroundPending() || Date.now() < state.verificationRetryAt || !emailField.input.reportValidity()) return
    request('sendVerification', { email: emailField.input.value.trim() })
  })
  addListener(loggedOut, 'keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation()
  })
  const chooseGroup = (value) => {
    if (!value || hasForegroundPending()) return
    if (value !== state.group) request('select', { group: value })
    else if (!state.configured) render()
  }
  addListener(groupSelect, 'click', (event) => {
    const option = event.target.closest?.('.y-group')
    if (option && !option.disabled) chooseGroup(option.dataset.value)
  })
  addListener(groupSelect, 'scroll', updateEdges, { passive: true })
  addListener(groupSearchInput, 'input', () => render())
  addListener(groupSearchInput, 'keydown', (event) => {
    if (event.key === 'Escape' && groupSearchInput.value) {
      event.stopPropagation()
      groupSearchInput.value = ''
      render()
    } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault()
      const first = groupOptions().find((option) => !option.hidden)
      if (event.key === 'Enter' && first && groupOptions().filter((option) => !option.hidden).length === 1) first.click()
      else first?.focus()
    }
  })
  addListener(groupSelect, 'keydown', (event) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const options = groupOptions().filter((option) => !option.hidden)
    const index = options.indexOf(document.activeElement)
    options[(index + step + options.length) % options.length]?.focus()
  })
  addListener(applyButton, 'click', () => {
    if (state.configured || state.pendingGroup) return
    if (!state.groups.length) request('login')
    else if (groupSelect.dataset.value) request('select', { group: groupSelect.dataset.value })
  })
  addListener(takeoverButton, 'click', () => {
    if (state.nativeSync !== 'account-change' || !state.configured || hasForegroundPending()) return
    request('reconfigure')
  })
  addListener(rechargeButton, 'click', () => request('recharge'))
  addListener(restoreButton, 'click', () => {
    confirmation.dataset.open = 'true'
    render()
    cancelRestore.focus()
  })
  addListener(cancelRestore, 'click', () => {
    confirmation.dataset.open = 'false'
    render()
  })
  addListener(confirmRestore, 'click', () => request('restore'))
  addListener(document, 'pointerdown', (event) => {
    // A popover dismisses on outside clicks, except while a login draft would be lost.
    if (!state.open || !state.loggedIn || panel.contains(event.target) || badge.contains(event.target)) return
    setOpen(false)
  }, true)
  addListener(document, 'keydown', (event) => {
    if (event.key === 'Escape' && state.open) {
      event.preventDefault()
      setOpen(false)
      badge.focus()
    }
  })
  addListener(document, 'visibilitychange', () => {
    if (!document.hidden) request('status')
  })
  addListener(window, 'resize', placeBadge)
  const pollTimer = window.setInterval(() => {
    if (!document.hidden) request('status')
  }, 60 * 1000)
  cleanups.push(() => window.clearInterval(pollTimer))
  const authTimer = window.setInterval(() => {
    if (state.open && !state.loggedIn && state.verificationRetryAt) render()
  }, 1000)
  cleanups.push(() => window.clearInterval(authTimer))

  const runtime = {
    nativeStatus(status) {
      if (disposed || !['pending', 'syncing', 'synced', 'error', 'account-change'].includes(status)) return
      if (state.nativeSync === status) return
      state.nativeSync = status
      if (status === 'synced') state.restartRequired = false
      render()
    },
    receive(response) {
      if (disposed || !response || !Number.isFinite(response.id)) return false
      const entry = pending.get(response.id)
      if (!entry) return false
      pending.delete(response.id)
      window.clearTimeout(entry.timer)
      if (entry.action === 'status' && (entry.id !== latestStatusId || hasForegroundPending() || entry.foregroundVersion !== foregroundVersion)) return true
      if (entry.action !== 'status' && entry.foregroundVersion !== foregroundVersion) return true
      let startSetup = false
      if (response.ok === true && response.data && typeof response.data === 'object') {
        const data = response.data
        state.error = ''
        if (entry.action === 'authOptions') {
          state.authReady = true
          state.passwordLoginEnabled = data.auth?.passwordLoginEnabled === true
          state.registrationEnabled = data.auth?.registrationEnabled === true
          state.emailVerificationEnabled = data.auth?.emailVerificationEnabled === true
          state.message = !state.passwordLoginEnabled ? '站点暂未开放密码登录。' : ''
        } else if (entry.action === 'login' && data.auth?.step === 'twoFactor') {
          state.loginId = cleanText(data.auth.loginId, 100)
          state.message = '请完成账号的二次验证。'
          clearAuthSecrets()
          window.setTimeout(() => twoFactorField.input.focus(), 0)
        } else if (entry.action === 'register' && data.registered === true) {
          state.authMode = 'login'
          clearAuthSecrets()
          state.message = '注册成功，请使用新账号登录。'
        } else if (entry.action === 'sendVerification' && data.verificationSent === true) {
          state.verificationRetryAt = Date.now() + 60 * 1000
          state.message = '验证码已发送，请查看邮箱。'
        } else {
          applyData(data, entry.action === 'status')
          if (data.configured && ['select', 'login'].includes(entry.action)) state.nativeSync = 'pending'
          startSetup = entry.action === 'login' && !entry.setup && state.loggedIn && state.setupPending
          if (startSetup) state.message = '登录成功，正在准备配置。'
        }
      } else failure(entry, response.code)
      if (entry.action !== 'status') foregroundVersion += 1
      render()
      if (startSetup) request('login')
      if (entry.action === 'status' && response.ok === true && !state.loggedIn && !state.authReady) request('authOptions')
      return true
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of pending.values()) window.clearTimeout(entry.timer)
      pending.clear()
      clearAuthSecrets()
      state.loginId = ''
      cleanups.splice(0).reverse().forEach((cleanup) => safe(cleanup))
      root.remove()
      if (window.__yisamaInfiniteAssistant === runtime) delete window.__yisamaInfiniteAssistant
    },
    snapshot() {
      return {
        loggedIn: state.loggedIn, configured: state.configured, username: state.username, quota: state.quota,
        group: state.group, groupLabel: state.groupLabel, groups: state.groups.map((group) => ({ ...group })),
        model: state.model, models: [...state.models], message: state.message, restartRequired: state.restartRequired,
        open: state.open, staleQuota: state.staleQuota, setupPending: state.setupPending,
      }
    },
  }
  window.__yisamaInfiniteAssistant = runtime
  render()
  placeBadge()
  request('status')
  return runtime
}

export function makeAssistantScript() {
  return `(() => {
    const install = ${installAssistantUI.toString()};
    let topFrame = false;
    try { topFrame = window.top === window; } catch {}
    if (!topFrame || window.location.href !== 'app://-/index.html') return null;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => install(), { once: true });
      return null;
    }
    return install();
  })()`
}

export const REMOVE_ASSISTANT_SCRIPT = `(() => {
  let topFrame = false;
  try { topFrame = window.top === window; } catch {}
  if (!topFrame || window.location.href !== 'app://-/index.html') return;
  window.__yisamaInfiniteAssistant?.dispose?.();
})()`
