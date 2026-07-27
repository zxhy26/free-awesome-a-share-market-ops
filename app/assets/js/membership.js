const featureSelector = "[data-member-feature]";
const paymentOrderStorageKey = "a-share-review-payment-order-v1";
const planDisplay = Object.freeze({
  month: { amount: "72 元", label: "月付会员 / 30 天" },
  year: { amount: "699 元", label: "包年会员 / 365 天" },
  lifetime: { amount: "1599 元", label: "定制永久版" },
});
const state = {
  membership: null,
  config: null,
  selectedPlan: "month",
  dialog: null,
  countdownTimer: 0,
  paymentOrder: null,
  paymentPollTimer: 0,
  paymentPolling: false,
};

document.addEventListener("click", (event) => {
  const featureControl = event.target.closest(featureSelector);
  if (!featureControl || state.membership?.active) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openMembership(featureControl.dataset.memberFeature || "该功能");
}, true);

function createDialog() {
  if (state.dialog) return state.dialog;
  const backdrop = document.createElement("div");
  backdrop.className = "membership-backdrop";
  backdrop.id = "membershipBackdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section class="membership-dialog" role="dialog" aria-modal="true" aria-labelledby="membershipTitle" tabindex="-1">
      <header>
        <div>
          <h2 id="membershipTitle">会员中心</h2>
          <p id="membershipSubtitle">顶部功能需开通会员后使用</p>
        </div>
        <button class="icon-button" id="membershipClose" type="button" title="关闭" aria-label="关闭">×</button>
      </header>
      <div class="membership-content">
        <div class="membership-status" id="membershipStatus">
          <div><strong id="membershipStatusTitle">正在读取授权</strong><span id="membershipStatusReason">请稍候</span></div>
          <div class="membership-expiry">
            <strong id="membershipCountdown"></strong>
            <span id="membershipExpiry"></span>
          </div>
        </div>
        <section class="membership-section" aria-labelledby="membershipPlanTitle">
          <h3 id="membershipPlanTitle">选择套餐</h3>
          <div class="membership-plans" role="group" aria-label="会员套餐">
            <button class="membership-plan" type="button" data-member-plan="month" aria-pressed="true">
              <strong>月付会员</strong><span>72 元 / 30 天</span>
            </button>
            <button class="membership-plan" type="button" data-member-plan="year" aria-pressed="false">
              <strong>包年会员</strong><span>699 元 / 365 天</span>
            </button>
            <button class="membership-plan" type="button" data-member-plan="lifetime" aria-pressed="false">
              <strong>定制永久版</strong><span>1599 元 / 永久有效</span>
            </button>
          </div>
        </section>
        <section class="membership-section" aria-labelledby="membershipPaymentTitle">
          <h3 id="membershipPaymentTitle">选择支付方式</h3>
          <div class="membership-payment-grid">
            <article class="membership-payment-card membership-payment-wechat">
              <strong class="membership-payment-provider">微信支付</strong>
              <div class="membership-qr-media" id="wechatQr"></div>
            </article>
            <article class="membership-payment-card membership-payment-alipay">
              <strong class="membership-payment-provider">支付宝支付</strong>
              <div class="membership-qr-media" id="alipayQr"></div>
            </article>
            <div class="membership-payment-summary">
              <p class="membership-payment-amount">当前应付 <b id="membershipPayAmount">72 元</b></p>
              <p id="membershipPayPlan">月付会员 / 30 天</p>
              <p id="membershipPaymentInstruction">选择微信或支付宝扫码付款，完成后请将付款截图和本机设备码发给管理员核验。</p>
              <button class="button button-primary membership-auto-payment" id="createPaymentOrder" type="button" hidden>生成本机专属付款码</button>
              <p class="membership-payment-status" id="membershipPaymentStatus" aria-live="polite"></p>
            </div>
          </div>
        </section>
        <section class="membership-section" aria-labelledby="membershipCreatorTitle">
          <h3 id="membershipCreatorTitle">会员内容</h3>
          <div class="membership-creator-card">
            <div class="membership-qr-media membership-creator-qr" id="creatorWechatQr"></div>
            <strong>添加创作者以获取会员内容</strong>
          </div>
        </section>
        <section class="membership-section" aria-labelledby="membershipDeviceTitle">
          <h3 id="membershipDeviceTitle">本机设备码</h3>
          <div class="membership-device-row">
            <input class="membership-device-code" id="membershipDeviceCode" type="text" readonly value="读取中">
            <button class="icon-button" id="copyDeviceCode" type="button" title="复制设备码" aria-label="复制设备码">⧉</button>
          </div>
          <ol class="membership-steps">
            <li id="membershipStepOne">扫码支付所选套餐金额。</li>
            <li id="membershipStepTwo">将付款截图和本机设备码发给管理员。</li>
            <li id="membershipStepThree">收到激活码后粘贴到下方并激活。</li>
          </ol>
          <p class="membership-message" id="membershipSupport"></p>
        </section>
        <section class="membership-section" aria-labelledby="membershipActivationTitle">
          <h3 id="membershipActivationTitle">输入激活码</h3>
          <div class="membership-activation">
            <textarea id="membershipActivationCode" spellcheck="false" placeholder="粘贴以 AFRP1. 开头的激活码"></textarea>
            <button class="button button-primary" id="activateMembership" type="button">立即激活</button>
          </div>
          <p class="membership-message" id="membershipMessage" aria-live="polite"></p>
        </section>
      </div>
    </section>`;
  document.body.append(backdrop);
  state.dialog = backdrop;

  backdrop.querySelector("#membershipClose").addEventListener("click", closeMembership);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeMembership();
  });
  backdrop.querySelectorAll("[data-member-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.selectedPlan === button.dataset.memberPlan) return;
      state.selectedPlan = button.dataset.memberPlan;
      clearPaymentOrder();
      renderPlans();
      renderConfig();
    });
  });
  backdrop.querySelector("#copyDeviceCode").addEventListener("click", copyDeviceCode);
  backdrop.querySelector("#activateMembership").addEventListener("click", activateMembership);
  backdrop.querySelector("#createPaymentOrder").addEventListener("click", createPaymentOrder);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) closeMembership();
  });
  return backdrop;
}

function renderPlans() {
  if (!state.dialog) return;
  state.dialog.querySelectorAll("[data-member-plan]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.memberPlan === state.selectedPlan));
  });
  const selected = planDisplay[state.selectedPlan] || planDisplay.month;
  const amount = state.dialog.querySelector("#membershipPayAmount");
  const plan = state.dialog.querySelector("#membershipPayPlan");
  if (amount) amount.textContent = selected.amount;
  if (plan) plan.textContent = selected.label;
}

function renderQr(containerId, config, altText) {
  const container = state.dialog?.querySelector(`#${containerId}`);
  if (!container) return;
  container.replaceChildren();
  if (config?.available && config.url) {
    const image = document.createElement("img");
    image.src = config.url;
    image.alt = altText;
    image.loading = "eager";
    container.append(image);
    return;
  }
  const placeholder = document.createElement("div");
  placeholder.className = "membership-qr-empty";
  placeholder.textContent = `${altText}待配置`;
  container.append(placeholder);
}

function renderQrPlaceholder(message) {
  const container = state.dialog?.querySelector("#wechatQr");
  if (!container) return;
  const placeholder = document.createElement("div");
  placeholder.className = "membership-qr-empty";
  placeholder.textContent = message;
  container.replaceChildren(placeholder);
}

function parseExpiry() {
  const timestamp = Date.parse(state.membership?.expiresAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function splitRemainingTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { totalSeconds, days, hours, minutes, seconds };
}

function formatCountdown(milliseconds, compact = false) {
  const remaining = splitRemainingTime(milliseconds);
  const hours = String(remaining.hours).padStart(2, "0");
  const minutes = String(remaining.minutes).padStart(2, "0");
  const seconds = String(remaining.seconds).padStart(2, "0");
  if (compact) return `${remaining.days}天${hours}:${minutes}`;
  return `剩余 ${remaining.days}天 ${hours}:${minutes}:${seconds}`;
}

function renderCountdown() {
  const membership = state.membership;
  const toolbarLabel = document.querySelector("#membershipButtonLabel");
  const countdown = state.dialog?.querySelector("#membershipCountdown");
  const expiry = state.dialog?.querySelector("#membershipExpiry");
  const expiresAt = parseExpiry();

  if (membership?.active && membership.permanent) {
    if (toolbarLabel) toolbarLabel.textContent = membership.planLabel || "定制永久版";
    if (countdown) countdown.textContent = "永久有效";
    if (expiry) expiry.textContent = "绑定当前设备";
    return;
  }

  if (!membership?.active || !expiresAt) {
    if (toolbarLabel) toolbarLabel.textContent = membership?.active ? membership.planLabel : "开通会员";
    if (countdown) countdown.textContent = "";
    if (expiry) {
      expiry.textContent = expiresAt
        ? `有效期至 ${new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })}`
        : "";
    }
    return;
  }

  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    window.clearInterval(state.countdownTimer);
    state.countdownTimer = 0;
    state.membership = {
      ...membership,
      active: false,
      remainingDays: 0,
      statusCode: "EXPIRED",
      planLabel: "会员已到期",
      reason: "会员已到期，请续费后重新激活。",
    };
    renderMembership();
    return;
  }

  if (toolbarLabel) toolbarLabel.textContent = `${membership.planLabel} ${formatCountdown(remainingMs, true)}`;
  if (countdown) countdown.textContent = formatCountdown(remainingMs);
  if (expiry) {
    expiry.textContent = `有效期至 ${new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })}`;
  }
}

function restartCountdown() {
  window.clearInterval(state.countdownTimer);
  state.countdownTimer = 0;
  renderCountdown();
  if (state.membership?.active && !state.membership.permanent && parseExpiry()) {
    state.countdownTimer = window.setInterval(renderCountdown, 1000);
  }
}

function renderMembership() {
  const membership = state.membership;
  document.querySelectorAll(featureSelector).forEach((control) => {
    control.classList.toggle("member-locked", !membership?.active);
    if (membership?.active) {
      control.removeAttribute("aria-haspopup");
      control.removeAttribute("title");
    } else {
      control.setAttribute("aria-haspopup", "dialog");
      control.setAttribute("title", "需开通会员");
    }
  });

  const toolbarButton = document.querySelector("#membershipButton");
  const toolbarLabel = document.querySelector("#membershipButtonLabel");
  if (toolbarButton && toolbarLabel) {
    toolbarButton.classList.toggle("is-active", Boolean(membership?.active));
    toolbarLabel.textContent = membership?.active ? membership.planLabel : "开通会员";
  }
  if (!state.dialog || !membership) return;

  const status = state.dialog.querySelector("#membershipStatus");
  status.classList.toggle("is-active", membership.active);
  state.dialog.querySelector("#membershipStatusTitle").textContent = membership.active
    ? `${membership.planLabel}已生效`
    : membership.planLabel || "尚未激活";
  state.dialog.querySelector("#membershipStatusReason").textContent = membership.reason || "";
  state.dialog.querySelector("#membershipDeviceCode").value = membership.deviceCode || "读取失败";
  renderCountdown();
}

function renderConfig() {
  if (!state.dialog) return;
  const automatic = Boolean(state.config?.officialAdapter?.enabled);
  const order = state.paymentOrder;
  const orderButton = state.dialog.querySelector("#createPaymentOrder");
  const instruction = state.dialog.querySelector("#membershipPaymentInstruction");
  const stepOne = state.dialog.querySelector("#membershipStepOne");
  const stepTwo = state.dialog.querySelector("#membershipStepTwo");
  const stepThree = state.dialog.querySelector("#membershipStepThree");

  orderButton.hidden = !automatic;
  orderButton.textContent = order ? "重新生成专属付款码" : "生成本机专属付款码";
  if (automatic) {
    if (order?.qrImageUrl) {
      renderQr("wechatQr", { available: true, url: order.qrImageUrl }, "微信付款二维码");
    } else {
      renderQrPlaceholder(order ? "正在恢复订单并检查到账状态" : "点击右侧按钮生成本机专属付款码");
    }
    instruction.textContent = "专属订单会绑定本机设备码，微信支付到账并验签成功后自动解锁。";
    stepOne.textContent = "选择套餐并生成本机专属付款码。";
    stepTwo.textContent = "使用微信扫码完成付款，请保持软件运行。";
    stepThree.textContent = "到账确认后本机将自动开通，无需输入激活码。";
  } else {
    renderQr("wechatQr", state.config?.wechat, "微信付款二维码");
    instruction.textContent = "选择微信或支付宝扫码付款，完成后请将付款截图和本机设备码发给管理员核验。";
    stepOne.textContent = "选择微信或支付宝，扫码支付所选套餐金额。";
    stepTwo.textContent = "将付款截图和本机设备码发给管理员。";
    stepThree.textContent = "收到激活码后粘贴到下方并激活。";
  }
  renderQr("alipayQr", state.config?.alipay, "支付宝付款二维码");
  renderQr("creatorWechatQr", state.config?.creatorWechat, "创作者微信二维码");
  const support = state.dialog.querySelector("#membershipSupport");
  const parts = [state.config?.supportName, state.config?.supportNote].filter(Boolean);
  support.textContent = parts.join(" · ");
}

function setPaymentMessage(message, type = "") {
  const element = state.dialog?.querySelector("#membershipPaymentStatus");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("is-error", type === "error");
  element.classList.toggle("is-success", type === "success");
}

function stopPaymentPolling() {
  window.clearTimeout(state.paymentPollTimer);
  state.paymentPollTimer = 0;
}

function savePaymentOrder() {
  try {
    if (!state.paymentOrder) {
      localStorage.removeItem(paymentOrderStorageKey);
      return;
    }
    const { orderId, plan, expiresAt } = state.paymentOrder;
    localStorage.setItem(paymentOrderStorageKey, JSON.stringify({ orderId, plan, expiresAt }));
  } catch (_) {
  }
}

function clearPaymentOrder() {
  stopPaymentPolling();
  state.paymentOrder = null;
  savePaymentOrder();
  setPaymentMessage("");
}

function restorePaymentOrder() {
  if (state.paymentOrder || !state.config?.officialAdapter?.enabled) return;
  try {
    const stored = JSON.parse(localStorage.getItem(paymentOrderStorageKey) || "null");
    const expiresAt = Date.parse(stored?.expiresAt || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(stored?.orderId || "") || expiresAt <= Date.now()) {
      localStorage.removeItem(paymentOrderStorageKey);
      return;
    }
    state.paymentOrder = {
      orderId: stored.orderId,
      plan: planDisplay[stored.plan] ? stored.plan : "month",
      expiresAt: stored.expiresAt,
      pollSeconds: state.config.officialAdapter.pollSeconds || 3,
      qrImageUrl: "",
    };
    state.selectedPlan = state.paymentOrder.plan;
  } catch (_) {
    try {
      localStorage.removeItem(paymentOrderStorageKey);
    } catch (_) {
    }
  }
}

function schedulePaymentPoll(delaySeconds) {
  stopPaymentPolling();
  if (!state.paymentOrder) return;
  state.paymentPollTimer = window.setTimeout(
    pollPaymentOrder,
    Math.max(2, Number(delaySeconds) || 3) * 1000,
  );
}

async function pollPaymentOrder() {
  if (!state.paymentOrder || state.paymentPolling) return;
  if (Date.parse(state.paymentOrder.expiresAt || "") <= Date.now()) {
    clearPaymentOrder();
    renderConfig();
    setPaymentMessage("专属付款码已过期，请重新生成。", "error");
    return;
  }
  state.paymentPolling = true;
  try {
    const response = await fetch(
      `/api/v1/membership/payment/order/${encodeURIComponent(state.paymentOrder.orderId)}`,
      { cache: "no-store" },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "到账状态查询失败");
    if (data.status === "paid" && data.membership?.active) {
      state.membership = data.membership;
      clearPaymentOrder();
      renderMembership();
      restartCountdown();
      renderConfig();
      setPaymentMessage("支付已确认，会员已经自动开通。", "success");
      return;
    }
    if (["closed", "expired", "failed"].includes(data.status)) {
      clearPaymentOrder();
      renderConfig();
      setPaymentMessage(data.message || "订单未完成，请重新生成付款码。", "error");
      return;
    }
    setPaymentMessage(data.message || "等待微信支付到账确认");
  } catch (error) {
    setPaymentMessage(error.message || "到账状态查询失败，正在继续重试。", "error");
  } finally {
    state.paymentPolling = false;
  }
  if (state.paymentOrder) schedulePaymentPoll(state.paymentOrder.pollSeconds);
}

async function createPaymentOrder() {
  const button = state.dialog?.querySelector("#createPaymentOrder");
  if (!button || !state.config?.officialAdapter?.enabled) return;
  button.disabled = true;
  clearPaymentOrder();
  renderConfig();
  setPaymentMessage("正在生成本机专属付款码");
  try {
    const response = await fetch("/api/v1/membership/payment/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: state.selectedPlan }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "专属付款码生成失败");
    state.paymentOrder = data;
    savePaymentOrder();
    renderConfig();
    setPaymentMessage(data.message || "请使用微信扫描专属付款码。");
    schedulePaymentPoll(data.pollSeconds);
  } catch (error) {
    setPaymentMessage(error.message || "专属付款码生成失败。", "error");
  } finally {
    button.disabled = false;
  }
}

function setMessage(message, type = "") {
  const element = state.dialog?.querySelector("#membershipMessage");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("is-error", type === "error");
  element.classList.toggle("is-success", type === "success");
}

async function loadMembership() {
  try {
    const response = await fetch("/api/v1/membership/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "授权状态读取失败");
    state.membership = data;
  } catch (error) {
    state.membership = {
      active: false,
      deviceCode: "",
      planLabel: "授权服务未就绪",
      reason: error.message || "授权服务无法连接",
    };
  }
  renderMembership();
  restartCountdown();
}

async function loadPaymentConfig() {
  try {
    const response = await fetch("/api/v1/membership/payment-config", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "支付配置读取失败");
    state.config = data;
  } catch (_) {
    state.config = { wechat: { available: false }, alipay: { available: false } };
  }
  restorePaymentOrder();
  renderPlans();
  renderConfig();
  if (state.paymentOrder) schedulePaymentPoll(0.1);
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  setMessage(successMessage, "success");
}

async function copyDeviceCode() {
  const deviceCode = state.membership?.deviceCode;
  if (!deviceCode) {
    setMessage("设备码尚未读取成功。", "error");
    return;
  }
  await copyText(deviceCode, "设备码已复制。");
}

async function activateMembership() {
  const textarea = state.dialog.querySelector("#membershipActivationCode");
  const activationCode = textarea.value.trim();
  if (!activationCode) {
    setMessage("请先粘贴激活码。", "error");
    textarea.focus();
    return;
  }
  const button = state.dialog.querySelector("#activateMembership");
  button.disabled = true;
  setMessage("正在校验激活码");
  try {
    const response = await fetch("/api/v1/membership/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activationCode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "激活失败");
    state.membership = data.membership;
    textarea.value = "";
    renderMembership();
    restartCountdown();
    setMessage("激活成功，顶部功能已经解锁。", "success");
  } catch (error) {
    setMessage(error.message || "激活失败，请核对激活码。", "error");
  } finally {
    button.disabled = false;
  }
}

function openMembership(feature = "") {
  const dialog = createDialog();
  dialog.hidden = false;
  document.body.style.overflow = "hidden";
  dialog.querySelector("#membershipSubtitle").textContent = state.membership?.active
    ? "查看会员状态或续费"
    : `${feature || "顶部功能"}需开通会员后使用`;
  renderPlans();
  renderMembership();
  renderConfig();
  dialog.querySelector(".membership-dialog").focus();
  loadMembership();
  loadPaymentConfig();
}

function closeMembership() {
  if (!state.dialog) return;
  state.dialog.hidden = true;
  document.body.style.overflow = "";
}

function init() {
  createDialog();
  document.querySelector("#membershipButton")?.addEventListener("click", () => openMembership(""));
  loadMembership();
  loadPaymentConfig();

  const url = new URL(location.href);
  if (url.searchParams.get("member") === "required") {
    const feature = url.searchParams.get("feature") || "该功能";
    url.searchParams.delete("member");
    url.searchParams.delete("feature");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    openMembership(feature);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
