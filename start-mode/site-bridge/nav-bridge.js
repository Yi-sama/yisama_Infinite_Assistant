// Injected into the New API app's HTML by nginx.
(() => {
  const isStaticPage = (u) => u.origin === location.origin &&
    (u.pathname === "/" || /^\/pricing\/?$/.test(u.pathname));
  const isSimpleModePage = (u) => u.origin === location.origin && /^\/start\/?$/.test(u.pathname);
  const isAuthPage = (pathname) => /^\/(?:sign-in|sign-up|oauth|callback)(?:\/|$)/.test(pathname);
  const simpleModePath = "/start/";
  const modeKey = "ys.start.mode";
  const rememberMode = (mode) => localStorage.setItem(modeKey, JSON.stringify(mode));

  addEventListener("click", (event) => {
    const target = event.target;
    const link = target && target.closest
      ? target.closest('a[data-yisama-simple-mode], a[href="/start/"], a[href="/start"]')
      : null;
    if (link) rememberMode("simple");
  }, true);

  const readMode = () => { try { return JSON.parse(localStorage.getItem(modeKey)); } catch { return null; } };
  // 从站外（首页、书签、地址栏）整页打开控制台入口：上次用简洁模式就直接去简洁模式。
  // 控制台内部的跳转不经过这里（是前端路由），所以不会把正在用专业模式的人弹走。
  if (/^\/(?:dashboard|console)\/?$/.test(location.pathname) && readMode() === "simple") {
    location.replace(simpleModePath);
    return;
  }
  // 刚从登录 / 注册 / OAuth 页过来：这时按上次的模式落地。跨整页跳转（OAuth 回调）用 sessionStorage 带过去。
  const authFlag = "ys.start.justAuth";
  let cameFromAuth = isAuthPage(location.pathname) || sessionStorage.getItem(authFlag) === "1";
  if (isAuthPage(location.pathname)) sessionStorage.setItem(authFlag, "1");

  // 用户在专业模式里停留，就把“上次的模式”记成专业；还没选过的先不记，留给首次选择弹窗。
  function rememberProfessionalMode() {
    const u = new URL(location.href);
    if (isStaticPage(u) || isSimpleModePage(u) || isAuthPage(u.pathname)) return;
    if (readMode()) rememberMode("pro");
  }

  // 返回 true 表示已经跳去简洁模式，后面的事都不用做了
  function landAfterAuth() {
    const u = new URL(location.href);
    if (isAuthPage(u.pathname)) {
      cameFromAuth = true;
      sessionStorage.setItem(authFlag, "1");
      return false;
    }
    if (!cameFromAuth || isStaticPage(u) || isSimpleModePage(u)) return false;
    cameFromAuth = false;
    sessionStorage.removeItem(authFlag);
    if (readMode() === "simple") {
      location.replace(simpleModePath);
      return true;
    }
    return false;
  }

  let chooser = null;
  function showChooser() {
    if (chooser || readMode()) return;
    chooser = document.createElement("div");
    chooser.setAttribute("data-yisama-mode-chooser", "true");
    chooser.innerHTML = `
<div role="dialog" aria-modal="true" aria-labelledby="ys-mode-title" style="position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:rgba(6,6,10,.72);backdrop-filter:blur(6px);font:15px/1.6 'Inter Tight','Noto Sans SC','PingFang SC','Microsoft YaHei UI',system-ui,sans-serif;color:#f3efe8">
  <div style="width:min(720px,100%);padding:32px clamp(18px,4vw,36px) 22px;border-radius:22px;background:#111118;border:1px solid rgba(255,255,255,.14);box-shadow:0 40px 120px -20px rgba(0,0,0,.8)">
    <h2 id="ys-mode-title" style="margin:0;text-align:center;font-size:clamp(22px,3vw,28px);line-height:1.3;font-weight:800">欢迎来到 YisamaAPI，你想用哪种界面？</h2>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:24px">
      <button type="button" data-ys-mode="simple" style="flex:1 1 240px;text-align:left;padding:20px;border-radius:16px;border:1px solid rgba(128,96,224,.6);background:rgba(128,96,224,.12);color:inherit;font:inherit;cursor:pointer">
        <strong style="display:block;font-size:18px">简洁模式</strong>
        <span style="display:block;margin-top:6px;color:#a29daa">一页看完 Key、余额和用量，需要时有教程</span>
        <em style="display:block;margin-top:12px;font-style:normal;color:#c9b8ff">适合大多数人 →</em>
      </button>
      <button type="button" data-ys-mode="pro" style="flex:1 1 240px;text-align:left;padding:20px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:inherit;font:inherit;cursor:pointer">
        <strong style="display:block;font-size:18px">专业模式</strong>
        <span style="display:block;margin-top:6px;color:#a29daa">多个 Key、分组、模型列表、详细日志</span>
        <em style="display:block;margin-top:12px;font-style:normal;color:#a29daa">留在完整控制台 →</em>
      </button>
    </div>
    <p style="margin:18px 0 0;text-align:center;font-size:13px;color:#6b6774">不确定就选简洁模式。以后随时可以在右上角切换，下次登录会进入你最后用的模式。</p>
  </div>
</div>`;
    chooser.addEventListener("click", (event) => {
      const button = event.target.closest && event.target.closest("[data-ys-mode]");
      if (!button) return;
      const mode = button.getAttribute("data-ys-mode");
      rememberMode(mode);
      if (mode === "simple") {
        location.assign(simpleModePath);
        return;
      }
      chooser.remove();
    });
    document.body.appendChild(chooser);
    const first = chooser.querySelector("[data-ys-mode]");
    if (first) first.focus();
  }

  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k];
    history[k] = function (state, title, url) {
      if (url != null) {
        const u = new URL(url, location.href);
        if (isStaticPage(u) && u.pathname !== location.pathname) {
          return location.assign(u.pathname === "/" ? "/" : "/pricing/");
        }
      }
      const result = orig.apply(this, arguments);
      queueMicrotask(ensureSimpleMode);
      return result;
    };
  }

  addEventListener("popstate", () => {
    const u = new URL(location.href);
    if (isStaticPage(u)) {
      location.replace(u.pathname === "/" ? "/" : "/pricing/");
      return;
    }
    queueMicrotask(ensureSimpleMode);
  });

  function findSearchButton(header) {
    return [...header.querySelectorAll("button")].find((button) => {
      const label = (button.getAttribute("aria-label") || "").trim();
      if (/^(search|搜索|搜尋)/i.test(label)) return true;
      return Boolean(button.querySelector("kbd")) && /⌘|ctrl|control/i.test(button.textContent || "");
    });
  }

  function ensureSimpleMode() {
    const current = new URL(location.href);
    if (isStaticPage(current) || isSimpleModePage(current)) return;
    if (landAfterAuth()) return;
    rememberProfessionalMode();
    let inApp = false;
    for (const header of document.querySelectorAll("header")) {
      const search = findSearchButton(header);
      const existing = header.querySelector('a[data-yisama-simple-mode], a[href="/start/"]');
      if (!search && !existing) continue;
      inApp = true;

      if (search) {
        search.hidden = true;
        search.setAttribute("data-yisama-search-hidden", "true");
      }
      if (existing) {
        existing.setAttribute("data-yisama-simple-mode", "true");
        continue;
      }

      const link = document.createElement("a");
      link.href = simpleModePath;
      link.textContent = "简洁模式";
      link.setAttribute("aria-label", "切换到简洁模式");
      link.setAttribute("data-yisama-simple-mode", "true");
      link.className = "text-muted-foreground hover:text-foreground inline-flex items-center rounded-md px-2 py-1 text-sm transition-colors";
      search.before(link);
    }
    // 只有控制台真的渲染出来（说明已登录）才弹首次选择
    if (inApp && !isAuthPage(current.pathname) && !readMode()) showChooser();
  }

  let scheduled = false;
  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureSimpleMode();
    });
  }

  const observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", scheduleEnsure, { once: true });
  } else {
    scheduleEnsure();
  }
})();
