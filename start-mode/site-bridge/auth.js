// Static pages share the app's HttpOnly session, not a separate stored login flag.
(() => {
  const actions = document.querySelector(".nav__actions");
  if (!actions) return;

  const account = actions.querySelector('a[href="/sign-in"]');
  const signups = [...document.querySelectorAll('a[href="/sign-up"]')].map((link) => ({
    link,
    label: link.querySelector("span") || link,
    original: (link.querySelector("span") || link).textContent,
  }));
  const loginLabel = account.textContent;
  let revision = 0;
  let pending = null;

  function render(user, state) {
    const guest = state === "anonymous";
    account.href = guest ? "/sign-in" : "/profile";
    account.textContent = guest ? loginLabel : user?.display_name || user?.username || "\u4e2a\u4eba\u4e2d\u5fc3";
    account.title = guest ? loginLabel : account.textContent;
    for (const { link, label, original } of signups) {
      // 已登录：进入上次用的模式（简洁 / 专业）
      let mode = null;
      try { mode = JSON.parse(localStorage.getItem("ys.start.mode")); } catch {}
      link.href = guest ? "/sign-up" : mode === "simple" ? "/start/" : "/dashboard";
      label.textContent = guest ? original : actions.contains(link) ? "\u63a7\u5236\u53f0" : "\u8fdb\u5165\u63a7\u5236\u53f0";
    }
    // 页面上其他“控制台 / 创建 API Key”入口也按上次的模式走
    if (!guest) {
      let mode = null;
      try { mode = JSON.parse(localStorage.getItem("ys.start.mode")); } catch {}
      for (const link of document.querySelectorAll('a[href="/dashboard"], a[href="/start/"][data-ys-entry]')) {
        link.setAttribute("data-ys-entry", "");
        link.href = mode === "simple" ? "/start/" : "/dashboard";
      }
    }
    actions.dataset.authState = state;
    actions.setAttribute("aria-busy", "false");
  }

  async function check() {
    const response = await fetch("/api/user/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401) return { user: null, state: "anonymous" };
    if (!response.ok) throw new Error("Session check failed");
    const payload = await response.json();
    const user = payload.data?.user;
    if (!payload.success || !Number.isInteger(user?.id) || user.id <= 0) {
      throw new Error("Invalid session response");
    }
    return { user, state: "authenticated" };
  }

  function sync() {
    if (pending) return pending;
    const current = revision;
    // Use the same lock as the console so refresh-cookie rotation cannot race it.
    const request = navigator.locks
      ? navigator.locks.request("new-api:auth-refresh", { mode: "exclusive" }, check)
      : check();
    pending = request.then(({ user, state }) => {
      if (current === revision) render(user, state);
    }).catch(() => {
      // A connection failure is not proof that a signed-in user has logged out.
      if (current === revision && actions.dataset.authState === "checking") render(null, "unknown");
    }).finally(() => {
      pending = null;
    });
    return pending;
  }

  function onSessionEvent(event) {
    if (event?.kind !== "signed_out" && event?.kind !== "authenticated") return;
    revision += 1;
    if (event.kind === "signed_out") {
      render(null, "anonymous");
    } else {
      pending ? pending.then(sync) : sync();
    }
  }

  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel("new-api:auth-session");
    channel.addEventListener("message", (event) => onSessionEvent(event.data));
  } else {
    addEventListener("storage", (event) => {
      if (event.key !== "new-api:auth-session:event" || !event.newValue) return;
      try { onSessionEvent(JSON.parse(event.newValue)); } catch {}
    });
  }
  addEventListener("pageshow", (event) => { if (event.persisted) sync(); });
  addEventListener("focus", sync);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  sync();
})();
