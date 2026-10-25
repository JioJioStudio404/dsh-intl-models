/**
 * dsh-intl-models — browser half.
 *
 * A hand-written module in the `window.__ModuleLoader__.load({ id, factory })`
 * shape every DSH client half uses (no ESM syntax). It requires only `react`
 * and the shared UI primitives, and talks to the host through the `intlModels`
 * Remote namespace. The vendor tabs show each key in full (at the user's
 * request); compact places (the switch notice, the Models-page card) mask it.
 *
 * It contributes:
 *  - one tab per vendor beside 对话 / 轨迹 (`conversation.view`): OpenAI,
 *    Claude, xAI, OpenRouter, OpenCode, Gemini (hideable). Each manages only its vendor:
 *    one card per endpoint with keys — each key on two lines (the key itself,
 *    then its validity, balance or plan quota, today's usage, switch /
 *    validity / refresh / edit / remove), drag order — the endpoint's model
 *    selection, its own switching settings, its export, and its add-keys
 *    dialog (paste, a file, or DSH's own keys), detecting among its endpoints;
 *  - each endpoint row's card on Settings → Models (`settings.models.provider-card`).
 */
window.__ModuleLoader__.load({
  id: "dsh-intl-models",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;

    const NS = "intl-models";
    /** The settings namespace of the plugin's Models-page rows (the bundle patch's row id). */
    const SETTINGS_NS = "dsh-intl-models";
    /** The (local, cheap) status is re-read this often while a view is open. */
    const STATUS_INTERVAL_MS = 15_000;
    /** Free checks (balances, plan windows) run this often while the tab is open. */
    const CHECK_INTERVAL_MS = 5 * 60_000;
    /** An automatic switch is announced for this long. */
    const SWITCH_NOTICE_MS = 30 * 60_000;
    /** Largest key file accepted. */
    const MAX_FILE_BYTES = 256 * 1024;

    const DICTS = {
      en: {
        "tab.label": "Intl models",
        "head.title": "{vendor} API keys",
        "head.tabs": "Tabs",
        "head.tabsTitle": "Switch vendor tabs on or off (a vendor switched off also leaves the model picker)",
        "tabs.title": "Vendor tabs",
        "tabs.keys": "{count} keys",
        "tabs.switchTitle": "Off: the tab is hidden and its models leave the model picker at the bottom (the keys are kept)",
        "tabs.last": "At least one vendor stays on",
        "tabs.save": "Save",
        "tabs.cancel": "Cancel",
        "tabs.close": "Close",
        "status.low": "Low balance",
        "head.autoSwitch": "Auto-switch keys",
        "head.autoSwitchHint": "When a key's balance or plan quota runs out, the next key (top to bottom) takes over.",
        "head.rotateOnRateLimit": "Also on rate limits",
        "head.rotateHint": "Rate limits count per account at these vendors: switching only helps when the keys belong to different accounts.",
        "head.validate": "Verify all",
        "head.validating": "Verifying…",
        "head.validateHint": "Check each key: does the vendor accept it, and — where no balance shows — is there money behind it (free for OpenAI and Claude; one tiny request for Gemini, xAI and OpenCode).",
        "head.funds": "Refresh quota",
        "head.fundsing": "Refreshing…",
        "head.fundsHint": "Re-read balances and plan windows (free). They also refresh when this tab opens, every 5 minutes, and after each request.",
        "head.export": "Export",
        "head.exporting": "Exporting…",
        "head.exported": "Exported {count} keys: {path}",
        "head.add": "Add keys",
        "empty": "No {vendor} key yet.",
        "notice.switched": "{time} switched key on {endpoint}: {from} → {to} ({reason})",
        "notice.dismiss": "Dismiss",
        "reason.invalid-key": "key invalid",
        "reason.expired": "no plan or expired",
        "reason.no-balance": "no balance",
        "reason.plan-quota": "plan quota used up",
        "reason.forbidden": "not allowed",
        "reason.rate-limit": "rate limited",
        "reason.unusable": "key unavailable",
        "reason.region": "region not supported",
        "section.plan": "Plan",
        "section.models": "Models {count}/{total}",
        "section.modelsTitle": "Choose the models this endpoint offers in the picker",
        "col.status": "Status",
        "col.balance": "Balance",
        "col.quota": "Quota",
        "col.usage": "Today",
        "status.ok": "Available",
        "status.valid": "Key valid",
        "status.validHint": "The vendor accepts the key; whether it has money is not known yet · use ✓ (free)",
        "status.validHintChat": "The vendor accepts the key; whether it has money is not known yet · use ✓ (one tiny request)",
        "status.freeOnly": "Free models only",
        "status.freeOnlyHint": "Balance $0: only free models answer",
        "status.freeUsedUp": "Free requests used up · back {time}",
        "status.probed": "proven usable on {model} {time} ago",
        "status.probeError": "Last availability check gave no verdict: {message}",
        "status.unknown": "Not checked",
        "status.unknownChat": "Not checked — use ✓ (one tiny request)",
        "status.no-balance": "No balance",
        "status.plan-quota": "Quota used up",
        "status.invalid": "Key invalid",
        "status.expired": "No plan / expired",
        "status.error": "Check failed",
        "status.held": "Paused until {time}",
        "status.recheck": "May have recovered · rechecking",
        "status.recheckManual": "May have recovered · use ✓",
        "status.no-balanceManual": "No balance · use ✓ to recheck",
        "status.lastError": "Last check failed: {message}",
        "status.checked": "checked {time} ago",
        "status.never": "never checked",
        "status.backAt": "back {time}",
        "key.copy": "Copy the key",
        "key.copied": "Copied",
        "balance.none": "—",
        "balance.noApi": "The vendor shows no balance or quota for this key",
        "funds.failed": "Read failed",
        "funds.stale": "as of {time} ago",
        "quota.window.5h": "5h",
        "quota.window.week": "Week",
        "quota.window.day": "Today",
        "quota.neuronsDetail": "Workers AI today: {used} of {limit} free neurons used by the account ({percent}% left), resets {time}; past them the Workers plan bills",
        "quota.cell": "{window} {percent}%",
        "quota.detail": "{window} window: {percent}% left, resets {time}",
        "usage.today": "{requests} req · {tokens}",
        "usage.none": "—",
        "usage.month": "This month: {requests} requests, {tokens} tokens",
        "usage.cost": "≈{cost}",
        "usage.monthCost": "This month: {requests} requests, {tokens} tokens, ≈{cost} (estimated from list prices; OpenRouter and xAI report their own)",
        "funds.free": "free {remaining}/{limit} today",
        "funds.keyLeft": "key limit left {amount}",
        "funds.spent": "spent today {day} · this week {week} · this month {month}",
        "funds.totalUsed": "spent so far {amount} (the team's, booked within seconds)",
        "funds.freeTier": "Free tier: free models only",
        "key.active": "In use",
        "key.switch": "Use",
        "key.validate": "Check key and availability",
        "key.validateChat": "Check key and availability (one tiny request)",
        "key.funds": "Refresh balance / quota",
        "key.edit": "Edit",
        "key.remove": "Remove",
        "key.removeConfirm": "Confirm",
        "key.drag": "Drag to reorder (or ↑ ↓). Switching tries keys top to bottom.",
        "add.title": "Add {vendor} API keys",
        "add.endpoint": "Endpoint",
        "add.auto": "Detect",
        "add.paste": "One key per line",
        "add.label": "Name (optional)",
        "add.optional": "{label} (optional)",
        "key.account": "account {account}",
        "key.gateway": "gateway {gateway}",
        "usage.neurons": "{neurons} neurons",
        "usage.neuronsTitle": "Workers AI today: about {neurons} neurons through this plugin (10,000 a day are free, reset at 00:00 UTC)",
        "models.paidPlan": "Paid plan",
        "models.paidPlanTitle": "Needs the Workers Paid plan",
        "models.credits": "Credits",
        "models.creditsTitle": "A third-party model: paid from AI Gateway credits (Unified Billing)",
        "add.submit": "Add",
        "add.working": "Checking…",
        "add.file": "From file",
        "add.dsh": "Import DSH keys",
        "add.dshNone": "DSH stores no key for this vendor.",
        "add.dshFound": "Found in DSH: {refs}",
        "add.ok": "{masked} → {endpoint}: {state}",
        "add.wrongVendor": "{masked}: {error}",
        "add.updated": "{masked} → {endpoint}: already added, updated ({state})",
        "add.fail": "{masked}: not added ({error})",
        "add.tooLarge": "{name}: too large to be a key file",
        "add.close": "Close",
        "edit.title": "Edit key {masked}",
        "edit.label": "Name",
        "edit.save": "Save",
        "edit.cancel": "Cancel",
        "models.title": "Models — {endpoint}",
        "models.selected": "{count} of {total} selected",
        "models.fetched": "list fetched {time} ago",
        "models.snapshot": "built-in list",
        "models.fetch": "Fetch list",
        "models.fetching": "Fetching…",
        "models.image": "image",
        "models.thinking": "thinking",
        "models.new": "new",
        "models.retiring": "retires {date}",
        "models.unusable": "unavailable",
        "models.search": "Search models",
        "models.shown": "{shown} shown",
        "models.free": "free",
        "models.freeOpenCode": "OpenCode's free models answer only inside the OpenCode app",
        "models.groupFree": "Free",
        "models.groupWorkers": "Workers AI · Cloudflare's own models (10,000 neurons free a day, then the Workers plan)",
        "models.groupBlocked": "Free, OpenCode app only (the platform refuses other apps)",
        "models.groupRestricted": "Not on the free tier · needs purchased credits (then press Fetch list)",
        "models.groupCount": "{count}",
        "models.groupSelected": "{count} selected",
        "models.otherVendor": "Other",
        "models.unfoldAll": "Unfold all",
        "models.foldAll": "Fold all",
        "models.price": "${input} / ${output}",
        "models.priceTitle": "USD per million tokens: input / output",
        "models.all": "All",
        "models.none": "None",
        "models.reset": "Default",
        "models.save": "Save",
        "models.cancel": "Cancel",
        "models.close": "Close",
        "card.summary": "{count} keys · in use: {key} ({state})",
        "card.none": "No key on this endpoint",
        "time.days": "{d}d {h}h",
        "time.hours": "{h}h {m}m",
        "time.minutes": "{m}m",
        "time.now": "<1m",
        "error.generic": "Failed: {message}",
        "error.unavailable": "The plugin's host half is not loaded yet — restart the app once after installing.",
      },
      zh: {
        "tab.label": "国际模型",
        "head.title": "{vendor} API Key",
        "head.tabs": "管理标签",
        "head.tabsTitle": "打开或关闭厂商标签（关闭的厂商，底部模型选择栏也不再显示它的模型）",
        "tabs.title": "厂商标签",
        "tabs.keys": "{count} 个 Key",
        "tabs.switchTitle": "关闭后隐藏这个标签，底部模型选择栏也不再显示它的模型（Key 保留）",
        "tabs.last": "至少保留一个厂商",
        "tabs.save": "保存",
        "tabs.cancel": "取消",
        "tabs.close": "关闭",
        "status.low": "余额偏低",
        "head.autoSwitch": "自动换 Key",
        "head.autoSwitchHint": "余额或套餐额度用尽时，按从上到下的顺序换下一个 Key。",
        "head.rotateOnRateLimit": "限流时也换",
        "head.rotateHint": "这些厂商的限流按账号计算：只有 Key 来自不同账号时，限流换 Key 才有用。",
        "head.validate": "验证全部",
        "head.validating": "正在验证…",
        "head.validateHint": "逐个检测 Key：厂商是否接受；不显示余额的厂商，再检测是否有余额（OpenAI、Claude 免费；Gemini、xAI、OpenCode 发一次最小请求）。",
        "head.funds": "刷新额度",
        "head.fundsing": "正在刷新…",
        "head.fundsHint": "重新读取余额和套餐额度（免费）。打开标签页时、之后每 5 分钟、每次请求后也会自动刷新。",
        "head.export": "导出",
        "head.exporting": "正在导出…",
        "head.exported": "已导出 {count} 个 Key：{path}",
        "head.add": "添加 Key",
        "empty": "还没有 {vendor} 的 Key。",
        "notice.switched": "{time} {endpoint} 已自动换 Key：{from} → {to}（{reason}）",
        "notice.dismiss": "关闭提示",
        "reason.invalid-key": "Key 无效",
        "reason.expired": "无套餐或已过期",
        "reason.no-balance": "余额不足",
        "reason.plan-quota": "套餐额度用尽",
        "reason.forbidden": "无权使用",
        "reason.rate-limit": "被限流",
        "reason.unusable": "Key 不可用",
        "reason.region": "所在地区不受支持",
        "section.plan": "套餐",
        "section.models": "模型 {count}/{total}",
        "section.modelsTitle": "选择这个接入点在模型选择器里提供的模型",
        "col.status": "状态",
        "col.balance": "余额",
        "col.quota": "额度",
        "col.usage": "今日用量",
        "status.ok": "可用",
        "status.valid": "Key 有效",
        "status.validHint": "厂商接受这个 Key，是否有余额尚未检测 · 点 ✓ 检测（免费）",
        "status.validHintChat": "厂商接受这个 Key，是否有余额尚未检测 · 点 ✓ 检测（发一次最小请求）",
        "status.freeOnly": "仅免费模型",
        "status.freeOnlyHint": "余额为 $0：只能用免费模型",
        "status.freeUsedUp": "今日免费次数用完 · {time} 恢复",
        "status.probed": "{time}前已用 {model} 实测可用",
        "status.probeError": "上次可用性检测未得出结论：{message}",
        "status.unknown": "未检测",
        "status.unknownChat": "未检测，点 ✓ 检测（发一次最小请求）",
        "status.no-balance": "余额不足",
        "status.plan-quota": "额度用尽",
        "status.invalid": "Key 无效",
        "status.expired": "无套餐 / 已过期",
        "status.error": "检测失败",
        "status.held": "暂停至 {time}",
        "status.recheck": "可能已恢复 · 正在重新检测",
        "status.recheckManual": "可能已恢复 · 点 ✓ 检测",
        "status.no-balanceManual": "余额不足 · 点 ✓ 重新检测",
        "status.lastError": "上次检测失败：{message}",
        "status.checked": "{time}前检测",
        "status.never": "尚未检测",
        "status.backAt": "{time} 恢复",
        "key.copy": "复制 Key",
        "key.copied": "已复制",
        "balance.none": "—",
        "balance.noApi": "厂商不提供这个 Key 的余额或额度查询",
        "funds.failed": "读取失败",
        "funds.stale": "{time}前的数据",
        "quota.window.5h": "5 小时",
        "quota.window.week": "本周",
        "quota.window.day": "今日",
        "quota.neuronsDetail": "Workers AI 今日帐户已用 {used} / {limit} 免费 neurons（剩余 {percent}%），{time} 重置；超出部分按 Workers 套餐计费",
        "quota.cell": "{window} {percent}%",
        "quota.detail": "{window}：剩余 {percent}%，{time} 重置",
        "usage.today": "{requests} 次 · {tokens}",
        "usage.none": "—",
        "usage.month": "本月：{requests} 次请求，{tokens} tokens",
        "usage.cost": "≈{cost}",
        "usage.monthCost": "本月：{requests} 次请求，{tokens} tokens，约 {cost}（按公开价格估算；OpenRouter 与 xAI 为平台实际计费）",
        "funds.free": "免费模型今日剩 {remaining}/{limit}",
        "funds.keyLeft": "Key 额度剩 {amount}",
        "funds.spent": "今日花费 {day} · 本周 {week} · 本月 {month}",
        "funds.totalUsed": "累计已用 {amount}（团队合计，几秒内更新）",
        "funds.freeTier": "免费账户：只能用免费模型",
        "key.active": "使用中",
        "key.switch": "切换",
        "key.validate": "检测有效性和余额",
        "key.validateChat": "检测有效性和余额（发一次最小请求）",
        "key.funds": "刷新余额 / 额度",
        "key.edit": "编辑",
        "key.remove": "删除",
        "key.removeConfirm": "确认删除",
        "key.drag": "拖动排序（或按 ↑ ↓），自动换 Key 按从上到下的顺序。",
        "add.title": "添加 {vendor} API Key",
        "add.endpoint": "接入点",
        "add.auto": "自动识别",
        "add.paste": "每行一个 Key",
        "add.label": "名称（可选）",
        "add.optional": "{label}（可选）",
        "key.account": "帐户 {account}",
        "key.gateway": "网关 {gateway}",
        "usage.neurons": "{neurons} neurons",
        "usage.neuronsTitle": "Workers AI 今日经本插件约用 {neurons} neurons（每天免费 10,000，UTC 0 点重置）",
        "models.paidPlan": "付费套餐",
        "models.paidPlanTitle": "需要 Workers Paid 套餐",
        "models.credits": "需充值",
        "models.creditsTitle": "第三方模型：用 AI Gateway 的 Credits 付费（统一计费）",
        "add.submit": "添加",
        "add.working": "正在检测…",
        "add.file": "从文件导入",
        "add.dsh": "导入 DSH Key",
        "add.dshNone": "DSH 里没有这个厂商的 Key。",
        "add.dshFound": "在 DSH 中找到：{refs}",
        "add.ok": "{masked} → {endpoint}：{state}",
        "add.wrongVendor": "{masked}：{error}",
        "add.updated": "{masked} → {endpoint}：已存在，已更新（{state}）",
        "add.fail": "{masked}：未添加（{error}）",
        "add.tooLarge": "{name}：文件过大，不是 Key 文件",
        "add.close": "关闭",
        "edit.title": "编辑 Key {masked}",
        "edit.label": "名称",
        "edit.save": "保存",
        "edit.cancel": "取消",
        "models.title": "模型 — {endpoint}",
        "models.selected": "已选 {count} / {total}",
        "models.fetched": "列表 {time}前获取",
        "models.snapshot": "内置列表",
        "models.fetch": "获取列表",
        "models.fetching": "正在获取…",
        "models.image": "图片",
        "models.thinking": "思考",
        "models.new": "新",
        "models.retiring": "{date} 下线",
        "models.unusable": "不可用",
        "models.search": "搜索模型",
        "models.shown": "显示 {shown} 个",
        "models.free": "免费",
        "models.freeOpenCode": "OpenCode 的免费模型只能在 OpenCode 客户端里使用",
        "models.groupFree": "免费模型",
        "models.groupWorkers": "Workers AI · Cloudflare 自家模型（每天 10,000 neurons 免费额度，超出按 Workers 套餐计费）",
        "models.groupBlocked": "免费模型 · 仅限 OpenCode 客户端（平台限制，这里无法使用）",
        "models.groupRestricted": "免费层不可用 · 需购买额度（购买后点「获取列表」）",
        "models.groupCount": "{count} 个",
        "models.groupSelected": "已选 {count}",
        "models.otherVendor": "其他",
        "models.unfoldAll": "全部展开",
        "models.foldAll": "全部收起",
        "models.price": "${input} / ${output}",
        "models.priceTitle": "每百万 tokens 价格（美元）：输入 / 输出",
        "models.all": "全选",
        "models.none": "全不选",
        "models.reset": "恢复默认",
        "models.save": "保存",
        "models.cancel": "取消",
        "models.close": "关闭",
        "card.summary": "{count} 个 Key · 使用中：{key}（{state}）",
        "card.none": "这个接入点还没有 Key",
        "time.days": "{d}天{h}小时",
        "time.hours": "{h}小时{m}分",
        "time.minutes": "{m}分钟",
        "time.now": "不到1分钟",
        "error.generic": "操作失败：{message}",
        "error.unavailable": "插件宿主端尚未加载——安装后请重启一次应用。",
      },
    };

    const CSS = [
      ".ix-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      // The tab fills the conversation width (a column flex parent would otherwise shrink it to its content).
      ".ix-view{box-sizing:border-box;width:100%;max-width:1320px;margin:0 auto;padding:20px 28px calc(var(--dsh-composer-height, 152px) + 24px)}",
      ".ix-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".ix-title{font-size:15px;font-weight:600;margin-right:4px}",
      ".ix-spacer{flex:1}",
      ".ix-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".ix-error{color:var(--dsw-alias-state-error-primary);font-size:12px}",
      ".ix-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}",
      ".ix-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".ix-switch{display:flex;align-items:center;gap:7px;margin-right:6px;color:var(--dsw-alias-label-secondary)}",
      // Every text button the same width (the in-use badge is not a button).
      ".ix-btn.ix-btn{min-width:92px;justify-content:center}",
      ".ix-banner{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".ix-banner>span{flex:1;min-width:0;overflow-wrap:anywhere;user-select:text}",
      ".ix-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}",
      ".ix-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      // One card per endpoint.
      ".ix-section{container-type:inline-size;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden}",
      ".ix-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;background:var(--dsw-alias-bg-layer-1,transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".ix-section-name{font-weight:600}",
      ".ix-tag{flex:none;font-size:11px;padding:1px 7px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".ix-tag[data-tone=plan]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      ".ix-tag[title]{cursor:help}",
      // A key's second line: status, balance or quota (only the column the endpoint has), today, actions.
      ".ix-grid{display:grid;grid-template-columns:minmax(150px,1fr) minmax(110px,.8fr) 236px;align-items:center;column-gap:14px;padding:3px 14px 10px 30px}",
      ".ix-section[data-funds=balance] .ix-grid,.ix-section[data-funds=quota] .ix-grid{grid-template-columns:minmax(150px,1fr) minmax(200px,1.5fr) minmax(110px,.8fr) 236px}",
      ".ix-thead{font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-top:6px;padding-bottom:6px}",
      ".ix-key{position:relative;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".ix-key:last-child{border-bottom:none}",
      ".ix-key[data-active=true]{box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary)}",
      ".ix-key[data-dead=true] .ix-funds,.ix-key[data-dead=true] .ix-usage{opacity:.45}",
      ".ix-key[data-dragging=true]{opacity:.45}",
      ".ix-key[data-drop]::after{content:\"\";position:absolute;left:0;right:0;height:2px;background:var(--dsw-alias-state-business-primary);pointer-events:none;z-index:1}",
      ".ix-key[data-drop=before]::after{top:-1px}",
      ".ix-key[data-drop=after]::after{bottom:-1px}",
      ".ix-grip{position:absolute;left:6px;top:7px;display:flex;align-items:center;justify-content:center;width:18px;height:24px;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary);opacity:.4;cursor:grab}",
      ".ix-key:hover .ix-grip,.ix-grip:focus-visible{opacity:1}",
      ".ix-grip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ix-grip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:0}",
      // A key's first line: name, tags, the key in full on one line (scrolls when it does not fit), copy.
      ".ix-line1{display:flex;align-items:center;gap:8px;min-width:0;padding:9px 14px 2px 30px}",
      ".ix-name-text{flex:none;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
      ".ix-full{flex:0 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:thin;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);user-select:all;-webkit-user-select:all}",
      ".ix-copy{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px}",
      ".ix-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ix-copy[data-copied=true]{color:var(--dsw-alias-state-success-primary)}",
      ".ix-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}",
      ".ix-chip::before{content:\"\";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".ix-chip[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
      ".ix-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}",
      ".ix-chip[data-tone=bad]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
      ".ix-funds{display:flex;align-items:center;gap:8px;min-width:0}",
      ".ix-funds[data-stale=true] .ix-amount,.ix-funds[data-stale=true] .ix-windows{opacity:.5}",
      ".ix-failed{flex:none;font-size:12px;color:var(--dsw-alias-state-warn-primary);cursor:help;border-bottom:1px dotted currentColor}",
      ".ix-amount{font-variant-numeric:tabular-nums;font-weight:600}",
      ".ix-windows{display:flex;gap:10px;flex:1;min-width:0}",
      ".ix-window{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}",
      ".ix-window-num{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".ix-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}",
      ".ix-fill{height:100%;border-radius:2px;background:var(--dsw-alias-state-success-primary)}",
      ".ix-fill[data-level=mid]{background:var(--dsw-alias-state-warn-primary)}",
      ".ix-fill[data-level=low]{background:var(--dsw-alias-state-error-primary)}",
      ".ix-usage{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".ix-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;white-space:nowrap}",
      // The in-use badge sits in the switch button's place, so the icons line up row to row.
      ".ix-slot{flex:none;width:92px;display:flex;justify-content:center}",
      ".ix-badge{font-size:11px;padding:3px 8px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff);white-space:nowrap}",
      ".ix-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px}",
      ".ix-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ix-icon:disabled{cursor:default}",
      ".ix-icon:disabled:not([aria-busy=true]){opacity:.3}",
      ".ix-icon[data-spin=true] svg{animation:ix-spin .9s linear infinite}",
      ".ix-icon[data-pulse=true] svg{animation:ix-pulse .9s ease-in-out infinite}",
      ".ix-icon[data-confirm=true]{color:var(--dsw-alias-state-error-primary);width:auto;padding:0 8px;font-size:12px}",
      "@keyframes ix-spin{to{transform:rotate(360deg)}}",
      "@keyframes ix-pulse{50%{opacity:.3}}",
      ".ix-note{padding:0 14px 8px 30px;font-size:12px}",
      // Narrow: no header row; the second line wraps, the actions keep to the right.
      "@container (max-width: 720px){.ix-section .ix-thead.ix-thead{display:none}.ix-section .ix-grid.ix-grid:not(.ix-thead){display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.ix-funds{min-width:180px}.ix-actions{margin-left:auto}}",
      // Dialogs.
      ".ix-modal.ix-modal{width:min(var(--ix-modal-width,640px),100%);max-height:100%}",
      ".ix-modal-wide{--ix-modal-width:860px}",
      // Gateways list hundreds of models: a big dialog.
      ".ix-modal-xl{--ix-modal-width:1120px}",
      ".ix-modal-content{flex:1 1 auto;min-height:0;overflow-y:auto}",
      ".ix-dialog{display:flex;flex-direction:column;gap:12px}",
      ".ix-field{display:flex;flex-direction:column;gap:5px}",
      ".ix-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".ix-select,.ix-text{box-sizing:border-box;width:100%;height:32px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}",
      ".ix-textarea{box-sizing:border-box;width:100%;min-height:120px;resize:vertical;font:12px/1.5 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px}",
      ".ix-select:focus,.ix-text:focus,.ix-textarea:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:1px}",
      ".ix-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".ix-tabrow{gap:10px;min-height:28px}",
      ".ix-tabname{min-width:96px;font-weight:600}",
      ".ix-link{border:none;background:none;padding:0;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));cursor:pointer;font-size:12px;align-self:flex-start}",
      ".ix-results{display:flex;flex-direction:column;gap:4px;font-size:12px;overflow-wrap:anywhere}",
      // A card per model, three to a row (fewer when the window is narrow).
      ".ix-model-groups{display:flex;flex-direction:column;gap:12px}",
      ".ix-model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(max(220px,calc((100% - 20px) / 3)),1fr));gap:10px}",
      ".ix-model-card{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}",
      ".ix-model-card:hover{border-color:var(--dsw-alias-border-l3)}",
      ".ix-model-card[data-selected=true]{border-color:var(--dsw-alias-state-business-primary)}",
      ".ix-model-card .ix-model-name{align-items:flex-start;overflow-wrap:anywhere}",
      ".ix-model-card .ix-model-name input{margin-top:2px}",
      ".ix-model-meta{display:flex;flex-wrap:wrap;gap:2px 8px;padding-left:22px}",
      ".ix-model-tag{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".ix-model-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".ix-model-tag[data-tone=free]{color:var(--dsw-alias-state-success-primary)}",
      ".ix-model-section{display:flex;flex-direction:column;gap:8px}",
      ".ix-model-group{display:flex;align-items:center;gap:6px;width:100%;padding:4px 2px 6px;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);background:none;font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}",
      ".ix-model-group .ix-muted{font-weight:400}",
      ".ix-caret{display:inline-block;width:12px;color:var(--dsw-alias-label-tertiary)}",
      ".ix-price{font-variant-numeric:tabular-nums}",
      ".ix-search.ix-search{width:220px;height:30px}",
      ".ix-empty{display:flex;align-items:center;gap:12px;font-size:13px;padding:14px 16px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary)}",
      ".ix-summary{display:flex;flex-direction:column;gap:4px;padding:2px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
    ].join("");
    const styleId = "dsh-intl-models/client.css";
    if (typeof document !== "undefined") {
      // A replaced module re-runs this factory; the newest stylesheet wins.
      document.querySelector(`style[data-plugin-css=${JSON.stringify(styleId)}]`)?.remove();
      const style = document.createElement("style");
      style.dataset.pluginCss = styleId;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /** Register the dictionaries once per live mount (a duplicate registration throws). */
    function installLocale(ctx) {
      const locale = ctx.locale;
      if (locale === undefined || typeof locale.register !== "function") return;
      try {
        if (typeof locale.bind === "function" && locale.bind(NS)("tab.label") !== "tab.label") return;
      } catch {
        /* an unreadable locale face is not a reason to skip the registration */
      }
      try {
        ctx.effect(() => locale.register(NS, DICTS), "dsh-intl-models: locale namespace");
      } catch (error) {
        console.warn("dsh-intl-models: locale namespace already registered; reusing it", error);
      }
    }

    // ---------------------------------------------------------------- store

    /** Vendor tabs, in order: id and the tab's English label (not translated). */
    const VENDOR_TABS = [["openai", "OpenAI"], ["anthropic", "Claude"], ["xai", "xAI"], ["openrouter", "OpenRouter"], ["opencode", "OpenCode"], ["gemini", "Gemini"], ["cloudflare", "Cloudflare"], ["vercel", "Vercel"]];
    const tabName = (vendor) => VENDOR_TABS.find(([id]) => id === vendor)?.[1] ?? vendor;

    /** One shared snapshot for every view; immutable updates. `checking` and `checkedAt` are per vendor. */
    let snapshot = { status: null, loading: false, checking: {}, error: null, checkedAt: {} };
    const listeners = new Set();
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const read = () => snapshot;
    const update = (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of [...listeners]) listener();
    };
    const useCn = () => React.useSyncExternalStore(subscribe, read, read);

    /** Host operations, bound in apply(). */
    let call = async () => {
      throw new Error("remote.intlModels is not mounted");
    };

    /** Run one operation; a returned status replaces the shared one. */
    async function run(method, request) {
      const value = await call(method, request ?? {});
      if (value && typeof value === "object" && Array.isArray(value.keys)) update({ status: value, error: null });
      return value;
    }

    async function loadStatus() {
      if (snapshot.loading) return;
      update({ loading: true });
      try {
        await run("status");
      } catch (error) {
        update({ error: String(error?.message ?? error) });
      } finally {
        update({ loading: false });
      }
    }

    /** The vendor an endpoint belongs to. */
    const vendorOf = (status, endpointId) => status?.endpoints?.find((endpoint) => endpoint.id === endpointId)?.vendor;
    /** One vendor's keys. */
    const keysOf = (status, vendor) => (status?.keys ?? []).filter((key) => vendorOf(status, key.endpoint) === vendor);

    /**
     * Check one vendor's keys. `auto` (the timer): what the vendor tells for
     * free; `funds`: balances and plan windows; `validity` (with `deep`, one
     * tiny request where nothing free validates a key). `checking[vendor]` is
     * the running mode.
     */
    async function checkVendor(vendor, { mode = "auto", deep = false } = {}) {
      if (snapshot.checking[vendor]) return;
      update({ checking: { ...snapshot.checking, [vendor]: mode } });
      try {
        await run("checkKeys", { vendor, ...(mode !== "auto" ? { mode } : {}), ...(deep ? { deep: true } : {}) });
        if (mode !== "validity") update({ checkedAt: { ...snapshot.checkedAt, [vendor]: Date.now() } });
      } catch (error) {
        update({ error: String(error?.message ?? error) });
      } finally {
        update({ checking: { ...snapshot.checking, [vendor]: false } });
      }
    }

    /**
     * Keep the shared state live while a view is on screen: every view reads
     * the (local, cheap) status; a vendor tab also runs that vendor's free
     * checks every 5 minutes — only that vendor's, only while it is open. A
     * hidden window polls nothing and catches up when shown again.
     */
    let statusWatchers = 0;
    let statusTimer;
    const vendorWatchers = new Map();
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const hasKeys = (vendor) => keysOf(snapshot.status, vendor).length > 0;
    const checksStale = (vendor) => Date.now() - (snapshot.checkedAt[vendor] ?? 0) > CHECK_INTERVAL_MS;
    const onVisibility = () => {
      if (!visible()) return;
      void loadStatus();
      for (const vendor of vendorWatchers.keys()) if (hasKeys(vendor) && checksStale(vendor)) void checkVendor(vendor);
    };
    function watch({ vendor } = {}) {
      statusWatchers += 1;
      if (statusWatchers === 1) {
        statusTimer = setInterval(() => { if (visible()) void loadStatus(); }, STATUS_INTERVAL_MS);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
      }
      if (vendor) {
        const entry = vendorWatchers.get(vendor) ?? { count: 0, timer: undefined };
        entry.count += 1;
        if (entry.count === 1) entry.timer = setInterval(() => { if (visible() && hasKeys(vendor)) void checkVendor(vendor); }, CHECK_INTERVAL_MS);
        vendorWatchers.set(vendor, entry);
      }
      void loadStatus().then(() => {
        if (vendor && hasKeys(vendor) && checksStale(vendor)) void checkVendor(vendor);
      });
      return () => {
        statusWatchers -= 1;
        if (vendor) {
          const entry = vendorWatchers.get(vendor);
          entry.count -= 1;
          if (entry.count === 0) {
            clearInterval(entry.timer);
            vendorWatchers.delete(vendor);
          }
        }
        if (statusWatchers === 0) {
          clearInterval(statusTimer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        }
      };
    }
    const useWatch = ({ vendor } = {}) => React.useEffect(() => watch({ vendor }), [vendor]);

    /** The hidden vendor tabs, cached in this browser so the tabs appear at once on the next load. */
    const HIDDEN_KEY = "dsh-intl-models:hidden-vendors";
    function readHidden() {
      try {
        const value = JSON.parse(globalThis.localStorage?.getItem(HIDDEN_KEY) ?? "[]");
        return Array.isArray(value) ? value.filter((id) => VENDOR_TABS.some(([vendor]) => vendor === id)) : [];
      } catch {
        return [];
      }
    }
    function writeHidden(hidden) {
      try {
        globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify(hidden));
      } catch {
        /* the host keeps the real setting */
      }
    }

    /** The switch notice the viewer closed (by its time), remembered in this browser. */
    const DISMISS_KEY = "dsh-intl-models:dismissed-switch";
    let dismissedSwitch = (() => {
      try {
        return globalThis.localStorage?.getItem(DISMISS_KEY) ?? null;
      } catch {
        return null;
      }
    })();
    function dismissSwitch(at) {
      dismissedSwitch = at;
      try {
        globalThis.localStorage?.setItem(DISMISS_KEY, at);
      } catch {
        /* the notice still closes for this page */
      }
      update({});
    }

    // ---------------------------------------------------------- pure helpers

    /** A countdown in the dictionary's units. */
    function duration(t, ms) {
      if (!Number.isFinite(ms) || ms <= 60_000) return t("time.now");
      const minutes = Math.round(ms / 60_000);
      const d = Math.floor(minutes / 1440);
      const hh = Math.floor((minutes % 1440) / 60);
      const m = minutes % 60;
      if (d > 0) return t("time.days", { d, h: hh });
      if (hh > 0) return t("time.hours", { h: hh, m });
      return t("time.minutes", { m });
    }
    const since = (t, value, now = Date.now()) => duration(t, now - (typeof value === "number" ? value : Date.parse(value)));

    /** "19:59" (or "19:59:31"), 24-hour, with the date when it is not today. */
    function clock(iso, { seconds = false } = {}) {
      const date = new Date(iso);
      if (!Number.isFinite(date.getTime())) return "";
      const pad = (value) => String(value).padStart(2, "0");
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;
      return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
    }

    /** "$32.35" / "¥1.20". */
    function money(balance) {
      if (!balance || typeof balance.amount !== "number") return null;
      const symbol = balance.currency === "CNY" ? "¥" : balance.currency === "USD" || !balance.currency ? "$" : `${balance.currency} `;
      return `${symbol}${balance.amount.toFixed(2)}`;
    }

    /** A small USD sum: "$0.0042", "$0.42", "$12.30". */
    const usd = (value) => (typeof value === "number" && Number.isFinite(value) ? `$${value >= 1 ? value.toFixed(2) : value >= 0.01 ? value.toFixed(3) : value.toFixed(4)}` : "—");

    /** Copy text to the clipboard (the async API, else the selection fallback). */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* fall back below */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(area);
        area.select();
        const done = document.execCommand("copy");
        area.remove();
        return done;
      } catch {
        return false;
      }
    }

    /** A balance worth a warning: under ¥5 (or $1). */
    const isLow = (balance) => typeof balance?.amount === "number" && balance.amount < (balance.currency === "USD" ? 1 : 5);
    /** A balance at zero (OpenRouter: only free models answer). */
    const freeOnly = (balance) => typeof balance?.amount === "number" && balance.amount <= 0;

    /** "12.3k" / "1.2M". */
    function compact(value) {
      const number = Number(value) || 0;
      if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
      if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}k`;
      return String(number);
    }
    const tokensOf = (bucket) => (Number(bucket?.input) || 0) + (Number(bucket?.output) || 0) + (Number(bucket?.cacheRead) || 0) + (Number(bucket?.cacheWrite) || 0);
    const level = (value) => (value === null || value === undefined ? "low" : value <= 15 ? "low" : value <= 40 ? "mid" : "ok");
    const keyTitle = (key) => key.label || key.masked;
    const unavailableError = (message) => /not mounted|invocation-unavailable|service-unavailable|definition-unavailable|binding-invalid/.test(String(message ?? ""));
    const windowName = (t, id) => (id === "5h" ? t("quota.window.5h") : id === "week" ? t("quota.window.week") : id === "day" ? t("quota.window.day") : id);
    /** A window's hover text: Cloudflare's daily neurons say how many of how many. */
    const windowDetail = (t, window) => (typeof window.used === "number" && typeof window.limit === "number"
      ? t("quota.neuronsDetail", { used: window.used, limit: window.limit.toLocaleString("en-US"), percent: window.remainingPercent, time: window.resetAt ? clock(window.resetAt) : "—" })
      : t("quota.detail", { window: windowName(t, window.id), percent: window.remainingPercent, time: window.resetAt ? clock(window.resetAt) : "—" }));

    /** The endpoints that have keys, in vendor then endpoint order, each with its keys. */
    function groupsOf(status) {
      const keys = status?.keys ?? [];
      return (status?.endpoints ?? []).filter((endpoint) => keys.some((key) => key.endpoint === endpoint.id)).map((endpoint) => ({
        endpoint,
        keys: keys.filter((key) => key.endpoint === endpoint.id),
      }));
    }

    /**
     * A key's status for its chip: tone, short label, and a full description
     * (balance, quota, the last check and its failures).
     */
    function statusInfo(t, key, endpoint, now = Date.now()) {
      const held = key.limitedUntil && Date.parse(key.limitedUntil) > now ? key.limitedUntil : null;
      // Where a balance shows (OpenRouter), it decides: $0 is free models only, under $1 is low.
      const free = key.status === "ok" && !held && endpoint?.showsBalance === true && freeOnly(key.balance);
      const low = key.status === "ok" && !held && !free && isLow(key.balance);
      // Elsewhere the vendor accepted the key, but nothing has proven money behind it yet (no probe, no served request).
      const unproven = key.status === "ok" && !held && Boolean(endpoint?.probe) && !key.probedAt;
      const freeUsedUp = key.status === "plan-quota" && held && endpoint?.showsBalance === true && freeOnly(key.balance) && key.balance?.freeRequests?.remaining === 0;
      const label = (() => {
        switch (key.status) {
          case "ok": return held ? t("status.held", { time: clock(held) }) : free ? t("status.freeOnly") : low ? t("status.low") : unproven ? t("status.valid") : t("status.ok");
          // A hold that ran out: the old verdict is stale until the next check.
          case "no-balance": return held ? t("status.no-balance") : endpoint?.freeCheck === false ? t("status.no-balanceManual") : t("status.recheck");
          case "plan-quota": return freeUsedUp ? t("status.freeUsedUp", { time: clock(held) }) : held ? `${t("status.plan-quota")} · ${t("status.backAt", { time: clock(held) })}` : endpoint?.freeCheck === false ? t("status.recheckManual") : t("status.recheck");
          case "invalid": return t("status.invalid");
          case "expired": return t("status.expired");
          case "error": return t("status.error");
          default: return t("status.unknown");
        }
      })();
      // A lapsed hold is being re-checked (free) — except a "no balance" only a paid probe can overturn.
      const lapsed = (key.status === "plan-quota" || (key.status === "no-balance" && endpoint?.freeCheck !== false)) && !held;
      const tone = key.status === "ok" ? (held || low ? "warn" : free || unproven ? "neutral" : "ok") : lapsed ? "neutral" : key.status === "plan-quota" || key.status === "no-balance" ? (key.status === "no-balance" ? "bad" : "warn") : key.status === "invalid" || key.status === "expired" ? "bad" : "neutral";
      const parts = [label];
      if (key.statusMessage && key.status !== "ok") parts.push(key.statusMessage);
      const amount = money(key.balance);
      if (amount) parts.push(amount);
      for (const window of key.quota?.windows ?? []) {
        if (typeof window.remainingPercent === "number") parts.push(windowDetail(t, window));
      }
      if (free) parts.push(t("status.freeOnlyHint"));
      if (unproven) parts.push(endpoint.probe === "request" ? t("status.validHintChat") : t("status.validHint"));
      if (key.status === "ok" && !held && key.probedAt && key.probeModel) parts.push(t("status.probed", { model: key.probeModel, time: since(t, key.probedAt, now) }));
      if (key.probeError) parts.push(t("status.probeError", { message: key.probeError }));
      if (key.probeNote) parts.push(key.probeNote);
      if (key.status === "unknown" && endpoint?.probe === "request") parts.push(t("status.unknownChat"));
      if (key.validityError && key.status !== "error") parts.push(t("status.lastError", { message: key.validityError }));
      if (key.quotaError) parts.push(`${t("funds.failed")}：${key.quotaError}`);
      parts.push(key.checkedAt ? t("status.checked", { time: since(t, key.checkedAt, now) }) : t("status.never"));
      return { tone, label, detail: parts.join(" · ") };
    }

    /** One result line of an add. */
    function addLine(t, result) {
      const shown = result.key ?? result.masked;
      if (!result.ok && result.kind === "wrong-vendor") return { tone: "warn", text: t("add.wrongVendor", { masked: shown, error: result.error }) };
      if (!result.ok) return { tone: "error", text: t("add.fail", { masked: shown, error: result.error ?? t("status.invalid") }) };
      // Accepted but not proven (no balance shows, the probe gave no verdict), or a $0 OpenRouter balance.
      const unproven = result.status === "ok" && result.probe && !result.probedAt;
      const head = result.status === "ok" && freeOnly(result.balance) ? t("status.freeOnly") : unproven ? t("status.valid") : t(`status.${result.status}`) ?? result.status;
      const state = [head, unproven && result.probeError ? t("status.probeError", { message: result.probeError }) : null, money(result.balance), ...(result.quota?.windows ?? []).filter((window) => typeof window.remainingPercent === "number").map((window) => t("quota.cell", { window: windowName(t, window.id), percent: window.remainingPercent }))].filter(Boolean).join(" · ");
      return { tone: result.status === "ok" && !unproven ? "ok" : result.status === "ok" ? "muted" : "warn", text: t(result.created ? "add.ok" : "add.updated", { masked: shown, endpoint: result.endpointName, state }) };
    }

    /** The order after dropping `dragId` before or after `targetId`; null when nothing moves. */
    function reordered(ids, dragId, targetId, after) {
      if (dragId === targetId || !ids.includes(dragId) || !ids.includes(targetId)) return null;
      const rest = ids.filter((id) => id !== dragId);
      const at = rest.indexOf(targetId) + (after ? 1 : 0);
      const next = [...rest.slice(0, at), dragId, ...rest.slice(at)];
      return next.every((id, index) => id === ids[index]) ? null : next;
    }

    /** The order after moving one id by `delta` places, or null at an edge. */
    function moved(ids, id, delta) {
      const from = ids.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return null;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    }

    const Grip = () => h("svg", { width: 10, height: 16, viewBox: "0 0 10 16", fill: "currentColor", "aria-hidden": true },
      [3, 8, 13].flatMap((cy) => [h("circle", { key: `l${cy}`, cx: 2.5, cy, r: 1.3 }), h("circle", { key: `r${cy}`, cx: 7.5, cy, r: 1.3 })]));
    const CopyIcon = () => h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), h("path", { d: "M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" }));
    const PenIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M10.5 2.5l3 3L6 13H3v-3z" }));
    const TrashIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" }));

    const ShieldIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M8 1.8l5 2v3.6c0 3.1-2.1 5.6-5 6.8-2.9-1.2-5-3.7-5-6.8V3.8z" }), h("path", { d: "M5.8 8.1l1.6 1.6 3-3.2" }));

    // ------------------------------------------------------------ components

    /**
     * A key's balance or plan windows — the column its endpoint has. A failed
     * read says so (reason in the tooltip) and dims the last numbers.
     */
    function FundsCell({ t, keyInfo: key, column }) {
      const failed = key.quotaError
        ? h("span", { className: "ix-failed", title: [key.quotaError, key.quotaAt ? t("funds.stale", { time: since(t, key.quotaAt) }) : null].filter(Boolean).join(" · ") }, t("funds.failed"))
        : null;
      const stale = failed ? "true" : "false";
      if (!key.funds) return h("div", { className: "ix-funds" }, h("span", { className: "ix-muted", title: t("balance.noApi") }, t("balance.none")));
      const windows = (key.quota?.windows ?? []).filter((window) => typeof window.remainingPercent === "number");
      if (column === "quota" && windows.length) {
        return h("div", { className: "ix-funds", "data-stale": stale },
          h("div", { className: "ix-windows" }, windows.map((window) => h("div", {
            key: window.id,
            className: "ix-window",
            title: windowDetail(t, window),
          },
            h("span", { className: `ix-window-num${window.remainingPercent === 0 ? " ix-warn" : ""}` }, t("quota.cell", { window: windowName(t, window.id), percent: window.remainingPercent })),
            h("div", { className: "ix-bar", role: "meter", "aria-label": windowName(t, window.id), "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": window.remainingPercent },
              h("div", { className: "ix-fill", "data-level": level(window.remainingPercent), style: { width: `${window.remainingPercent}%` } }))))),
          failed);
      }
      const amount = money(key.balance);
      if (column === "balance" && (amount || key.balance)) {
        const balance = key.balance ?? {};
        const notes = [
          typeof balance.keyRemaining === "number" ? t("funds.keyLeft", { amount: usd(balance.keyRemaining) }) : null,
          balance.freeRequests ? t("funds.free", { remaining: balance.freeRequests.remaining, limit: balance.freeRequests.limit }) : null,
        ].filter(Boolean);
        const spent = balance.spent ? t("funds.spent", { day: usd(balance.spent.day), week: usd(balance.spent.week), month: usd(balance.spent.month) })
          : typeof balance.totalUsed === "number" ? t("funds.totalUsed", { amount: usd(balance.totalUsed) }) : null;
        const title = [balance.freeTier ? t("funds.freeTier") : null, spent].filter(Boolean).join(" · ") || undefined;
        return h("div", { className: "ix-funds", "data-stale": stale, title },
          amount ? h("span", { className: `ix-amount${isLow(balance) && !freeOnly(balance) ? " ix-warn" : ""}` }, amount) : null,
          notes.length ? h("span", { className: "ix-muted" }, notes.join(" · ")) : null,
          failed);
      }
      return h("div", { className: "ix-funds" }, failed ?? h("span", { className: "ix-muted", title: key.quotaHint ?? undefined }, t("balance.none")));
    }

    function KeyRow({ t, keyInfo: key, endpoint, column, drag, onEdit }) {
      const [busy, setBusy] = React.useState(null);
      const [confirming, setConfirming] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [copied, setCopied] = React.useState(false);
      const info = statusInfo(t, key, endpoint);
      const copy = async () => {
        if (await copyText(key.key ?? "")) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      };
      const dead = key.status === "invalid" || key.status === "expired";
      const stop = (handler) => (event) => {
        event?.stopPropagation?.();
        handler(event);
      };
      const act = async (method, request) => {
        setError(null);
        try {
          await run(method, request);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      const check = async (mode) => {
        setBusy(mode);
        await act("checkKeys", { keyIds: [key.id], mode, ...(mode === "validity" ? { deep: true } : {}) });
        setBusy(null);
      };
      const day = key.usage?.day;
      const month = key.usage?.month;
      // The plan a key belongs to when its endpoint does not say (MiniMax M Plan keys).
      const planTag = key.planLabel && !endpoint?.plan ? key.planLabel : null;
      return h("li", {
        className: "ix-key",
        "data-active": key.active ? "true" : "false",
        "data-dead": dead ? "true" : "false",
        "data-dragging": drag?.dragging ? "true" : "false",
        "data-drop": drag?.drop ?? undefined,
        onDragOver: drag?.onDragOver,
        onDrop: drag?.onDrop,
      },
        drag?.enabled ? h("span", {
          className: "ix-grip",
          role: "button",
          tabIndex: 0,
          draggable: true,
          title: t("key.drag"),
          "aria-label": t("key.drag"),
          onKeyDown: (event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            drag.onMove(event.key === "ArrowUp" ? -1 : 1);
          },
          onDragStart: drag.onDragStart,
          onDragEnd: drag.onDragEnd,
        }, h(Grip)) : null,
        // Line 1: who it is, and the key in full on one line.
        h("div", { className: "ix-line1" },
          key.label ? h("span", { className: "ix-name-text", title: key.label }, key.label) : null,
          planTag ? h("span", { className: "ix-tag", "data-tone": "plan" }, planTag) : null,
          key.account ? h("span", { className: "ix-tag", title: [`Account ID ${key.params?.account ?? ""}`, key.params?.gateway ? `Gateway ID ${key.params.gateway}` : null].filter(Boolean).join(" · ") }, [t("key.account", { account: key.account }), key.params?.gateway ? t("key.gateway", { gateway: key.params.gateway }) : null].filter(Boolean).join(" · ")) : null,
          h("code", { className: "ix-full" }, key.key ?? key.masked),
          key.key ? h("button", { type: "button", className: "ix-copy", title: copied ? t("key.copied") : t("key.copy"), "aria-label": t("key.copy"), "data-copied": copied ? "true" : "false", onClick: stop(() => void copy()) }, copied ? "✓" : h(CopyIcon)) : null),
        // Line 2: its state.
        h("div", { className: "ix-grid" },
          h("div", { className: "ix-status" }, h("span", { className: "ix-chip", "data-tone": info.tone, title: info.detail }, info.label)),
          column ? h(FundsCell, { t, keyInfo: key, column }) : null,
          h("div", {
            className: "ix-usage",
            title: [month ? t("usage.monthCost", { requests: month.requests ?? 0, tokens: compact(tokensOf(month)), cost: usd(month.cost ?? 0) }) : null, day?.neurons > 0 ? t("usage.neuronsTitle", { neurons: compact(Math.round(day.neurons)) }) : null].filter(Boolean).join("\n") || undefined,
          }, day?.requests ? [t("usage.today", { requests: day.requests, tokens: compact(tokensOf(day)) }), day.cost > 0 ? t("usage.cost", { cost: usd(day.cost) }) : null, day.neurons > 0 ? t("usage.neurons", { neurons: compact(Math.round(day.neurons * 10) / 10) }) : null].filter(Boolean).join(" · ") : t("usage.none")),
          h("div", { className: "ix-actions" },
            h("span", { className: "ix-slot" }, key.active
              ? h("span", { className: "ix-badge" }, t("key.active"))
              : h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: dead, onClick: stop(() => void act("switchKey", { keyId: key.id })) }, t("key.switch"))),
            h("button", {
              type: "button",
              className: "ix-icon",
              title: endpoint?.probe === "request" ? t("key.validateChat") : t("key.validate"),
              "aria-label": t("key.validate"),
              "aria-busy": busy === "validity",
              disabled: busy !== null,
              "data-pulse": busy === "validity" ? "true" : "false",
              onClick: stop(() => void check("validity")),
            }, h(ShieldIcon)),
            h("button", {
              type: "button",
              className: "ix-icon",
              title: key.funds ? t("key.funds") : t("balance.noApi"),
              "aria-label": t("key.funds"),
              "aria-busy": busy === "funds",
              disabled: busy !== null || !key.funds,
              "data-spin": busy === "funds" ? "true" : "false",
              onClick: stop(() => void check("funds")),
            }, h(P.IconRefreshOutlineRegular, { size: 14 })),
            h("button", { type: "button", className: "ix-icon", title: t("key.edit"), "aria-label": t("key.edit"), onClick: stop(() => onEdit(key)) }, h(PenIcon)),
            h("button", {
              type: "button",
              className: "ix-icon",
              "data-confirm": confirming ? "true" : "false",
              title: t("key.remove"),
              "aria-label": confirming ? t("key.removeConfirm") : t("key.remove"),
              onClick: stop(() => {
                if (!confirming) {
                  setConfirming(true);
                  setTimeout(() => setConfirming(false), 4000);
                  return;
                }
                void act("removeKey", { keyId: key.id });
              }),
            }, confirming ? t("key.removeConfirm") : h(TrashIcon)))),
        error ? h("div", { className: "ix-error ix-note", role: "alert" }, t("error.generic", { message: error })) : null);
    }

    /** Well-known vendors, in the order a gateway's groups start with; the rest follow alphabetically. */
    const VENDOR_ORDER = [
      [/anthropic|claude/i, "Anthropic"],
      [/openai|\bgpt|^o\d/i, "OpenAI"],
      [/google|gemini|gemma/i, "Google"],
      [/x-?ai\b|grok/i, "xAI"],
      [/deepseek/i, "DeepSeek"],
      [/qwen|alibaba/i, "Qwen"],
      [/moonshot|kimi/i, "Moonshot AI"],
      [/z\.ai|z-ai|zhipu|glm/i, "Z.ai"],
      [/minimax/i, "MiniMax"],
      [/xiaomi|mimo/i, "Xiaomi"],
    ];
    /** OpenCode's model ids carry no vendor: their family names it. */
    const FAMILIES = [
      ...VENDOR_ORDER,
      [/mistral|devstral|codestral|magistral/i, "Mistral"],
      [/llama/i, "Meta"],
      [/nemotron/i, "NVIDIA"],
      [/longcat/i, "Meituan"],
      [/^(ling|ring)-/i, "inclusionAI"],
      [/^step-/i, "StepFun"],
      [/^hy\d|hunyuan/i, "Tencent"],
      [/ernie/i, "Baidu"],
      [/seed|doubao/i, "ByteDance"],
    ];
    const vendorRank = (label) => {
      const index = VENDOR_ORDER.findIndex(([pattern]) => pattern.test(label));
      return index < 0 ? VENDOR_ORDER.length : index;
    };

    /** Vercel's model owners (the id's prefix) that no family pattern names, as their makers write them. */
    const OWNERS = {
      zai: "Z.ai", meta: "Meta", nvidia: "NVIDIA", amazon: "Amazon", cohere: "Cohere", tencent: "Tencent", bytedance: "ByteDance",
      inclusionai: "inclusionAI", stepfun: "StepFun", meituan: "Meituan", perplexity: "Perplexity", spacexai: "xAI",
    };

    /**
     * Which vendor a gateway's model comes from, and its name without it:
     * OpenRouter names its models "Vendor: Model" (its ids "vendor/model");
     * Vercel's ids start with the owner; OpenCode's ids name a family. Null
     * when nothing tells.
     */
    function modelVendor(endpoint, entry) {
      const name = String(entry.name ?? entry.id);
      const named = /^([^:]{2,40}):\s+(.+)$/.exec(name);
      if (endpoint.vendor === "openrouter") {
        if (named) return { vendor: named[1].trim(), short: named[2] };
        const prefix = String(entry.id).replace(/^~/, "").split("/")[0];
        return { vendor: prefix === "openrouter" ? "OpenRouter" : prefix || null, short: name };
      }
      if (endpoint.vendor === "vercel") {
        const owner = String(entry.id).split("/")[0];
        return { vendor: OWNERS[owner] ?? FAMILIES.find(([pattern]) => pattern.test(owner))?.[1] ?? (owner || null), short: name };
      }
      const family = FAMILIES.find(([pattern]) => pattern.test(entry.id))?.[1];
      if (family || endpoint.vendor !== "cloudflare") return { vendor: family ?? null, short: name };
      return { vendor: String(entry.id).replace(/^@cf\//, "").split("/")[0] || null, short: name };
    }

    /** "$0.41238" → "0.412": three significant digits are plenty for a price per million tokens. */
    const priceText = (value) => (typeof value === "number" && Number.isFinite(value) ? String(Number(value.toPrecision(3))) : "?");

    /**
     * One endpoint's model chooser: a card per model, three to a row. A
     * gateway (OpenRouter, OpenCode) groups its models by vendor — free models
     * first, then one foldable group per vendor (open when it holds a selected
     * model, or while searching); OpenCode's free models answer only inside the
     * OpenCode app, and Vercel's free tier serves only some models, so those
     * come last, greyed out and not selectable.
     */
    function ModelsDialog({ t, endpoint, models, onClose }) {
      const options = models?.options ?? [];
      const usable = options.filter((entry) => !entry.blocked);
      const [draft, setDraft] = React.useState(() => new Set(usable.filter((entry) => entry.enabled).map((entry) => entry.id)));
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [query, setQuery] = React.useState("");
      const ids = usable.map((entry) => entry.id);
      const gateway = ["openrouter", "opencode", "cloudflare", "vercel"].includes(endpoint.vendor);
      const other = t("models.otherVendor");
      const vendorOf = (entry) => (gateway ? modelVendor(endpoint, entry) : { vendor: null, short: entry.name ?? entry.id });
      // A long list (OpenRouter, OpenCode) gets a search box (id, name or vendor); "all" and "none" act on what is shown.
      const searchable = options.length > 20;
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matches = (entry) => words.every((word) => `${entry.id} ${entry.name} ${vendorOf(entry).vendor ?? ""}`.toLowerCase().includes(word));
      const groups = (() => {
        if (!gateway) return [{ id: "all", entries: options }];
        // The group on top: free models; on Cloudflare its own (Workers AI, `@cf/…`: they share the
        // daily free allocation of neurons), apart from the third-party models credits pay for.
        const pinned = endpoint.vendor === "cloudflare"
          ? { id: "workers", title: t("models.groupWorkers"), test: (entry) => String(entry.id).startsWith("@cf/") }
          : { id: "free", title: t("models.groupFree"), test: (entry) => entry.free };
        const byVendor = new Map();
        for (const entry of usable.filter((item) => !pinned.test(item))) {
          const label = vendorOf(entry).vendor ?? other;
          if (!byVendor.has(label)) byVendor.set(label, []);
          byVendor.get(label).push(entry);
        }
        const vendors = [...byVendor.keys()].sort((a, b) => (a === other) - (b === other) || vendorRank(a) - vendorRank(b) || a.localeCompare(b, "en", { sensitivity: "base" }));
        const byRank = (a, b) => vendorRank(vendorOf(a).vendor ?? "") - vendorRank(vendorOf(b).vendor ?? "") || String(a.name).localeCompare(String(b.name), "en", { sensitivity: "base" });
        return [
          { id: pinned.id, title: pinned.title, entries: usable.filter(pinned.test).sort(byRank), mixed: true },
          ...vendors.map((label) => ({ id: `vendor:${label}`, title: label, entries: byVendor.get(label) })),
          { id: "blocked", title: endpoint.vendor === "vercel" ? t("models.groupRestricted") : t("models.groupBlocked"), entries: options.filter((entry) => entry.blocked), mixed: true },
        ];
      })().map((group) => ({ ...group, entries: group.entries.filter(matches) })).filter((group) => group.entries.length > 0);
      // Folded groups: the one on top and those holding a selected model start open.
      const [open, setOpen] = React.useState(() => new Set(groups.filter((group) => group.id === "free" || group.id === "workers" || group.entries.some((entry) => draft.has(entry.id))).map((group) => group.id)));
      const isOpen = (group) => !gateway || words.length > 0 || open.has(group.id);
      const flip = (id) => {
        const set = new Set(open);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        setOpen(set);
      };
      const shown = groups.flatMap((group) => group.entries);
      const shownIds = shown.filter((entry) => !entry.blocked).map((entry) => entry.id);
      const toggle = (id, next) => {
        const set = new Set(draft);
        if (next) set.add(id);
        else set.delete(id);
        setDraft(set);
      };
      const act = async (label, method, request, after) => {
        setBusy(label);
        setError(null);
        try {
          const value = await run(method, request);
          after?.(value);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
        }
      };
      const fetched = models?.fetchedAt ? t("models.fetched", { time: since(t, models.fetchedAt) }) : models?.live === false ? t("models.snapshot") : null;
      // In a vendor's group the vendor is said once, in its title; free models keep it (they mix vendors), minus "(free)".
      const nameOf = (entry, group) => {
        const { short } = vendorOf(entry);
        const name = group.mixed ? String(entry.name ?? entry.id) : short;
        return entry.free ? name.replace(/\s*\(free\)\s*$/i, "") : name;
      };
      // Why a model cannot be picked: OpenCode's platform rule (localized), else the host's reason (Vercel's free tier).
      const blockedText = (entry) => (endpoint.vendor === "opencode" ? t("models.freeOpenCode") : entry.blocked);
      const card = (entry, group) => {
        const checked = !entry.blocked && draft.has(entry.id);
        const tags = [
          entry.free ? h("span", { key: "free", className: "ix-model-tag", "data-tone": entry.blocked ? "warn" : "free", title: entry.blocked ? blockedText(entry) : undefined }, t("models.free")) : null,
          entry.price && !entry.free ? h("span", { key: "price", className: "ix-model-tag ix-price", title: t("models.priceTitle") }, t("models.price", { input: priceText(entry.price.input), output: priceText(entry.price.output) })) : null,
          entry.image ? h("span", { key: "image", className: "ix-model-tag" }, t("models.image")) : null,
          entry.reasoning ? h("span", { key: "thinking", className: "ix-model-tag" }, t("models.thinking")) : null,
          entry.newer ? h("span", { key: "new", className: "ix-model-tag" }, t("models.new")) : null,
          entry.paidPlan ? h("span", { key: "paid", className: "ix-model-tag", title: t("models.paidPlanTitle") }, t("models.paidPlan")) : null,
          entry.credits ? h("span", { key: "credits", className: "ix-model-tag", title: t("models.creditsTitle") }, t("models.credits")) : null,
          entry.retiring ? h("span", { key: "retiring", className: "ix-model-tag", "data-tone": "warn" }, t("models.retiring", { date: entry.retiring.slice(5).replace("-", "/") })) : null,
          entry.unusable ? h("span", { key: "unusable", className: "ix-model-tag", "data-tone": "warn", title: entry.unusable }, t("models.unusable")) : null,
        ].filter(Boolean);
        return h("div", {
          key: entry.id,
          className: "ix-model-card",
          "data-selected": checked ? "true" : undefined,
          "data-blocked": entry.blocked ? "true" : undefined,
          title: entry.blocked ? `${entry.id} · ${blockedText(entry)}` : entry.id,
        },
          h(P.Checkbox, { className: "ix-model-name", checked, disabled: Boolean(entry.blocked), label: nameOf(entry, group), onChange: (next) => toggle(entry.id, next) }),
          tags.length ? h("div", { className: "ix-model-meta" }, tags) : null);
      };
      const section = (group) => {
        const grid = h("div", { className: "ix-model-grid" }, group.entries.map((entry) => card(entry, group)));
        if (!gateway) return h("section", { key: group.id, className: "ix-model-section" }, grid);
        const picked = group.entries.filter((entry) => !entry.blocked && draft.has(entry.id)).length;
        const expanded = isOpen(group);
        return h("section", { key: group.id, className: "ix-model-section", "data-group": group.id },
          h("button", { type: "button", className: "ix-model-group", "aria-expanded": expanded ? "true" : "false", onClick: () => flip(group.id) },
            h("span", { className: "ix-caret", "aria-hidden": true }, expanded ? "▾" : "▸"),
            h("span", null, group.title),
            h("span", { className: "ix-muted" }, [t("models.groupCount", { count: group.entries.length }), picked ? t("models.groupSelected", { count: picked }) : null].filter(Boolean).join(" · "))),
          expanded ? grid : null);
      };
      const allOpen = groups.every((group) => open.has(group.id));
      return h(P.Modal, {
        open: true,
        onClose,
        title: t("models.title", { endpoint: endpoint.name }),
        closeLabel: t("models.close"),
        className: gateway ? "ix-modal ix-modal-xl" : "ix-modal ix-modal-wide",
        contentClassName: "ix-modal-content",
        children: h("div", { className: "ix-dialog" },
          h("div", { className: "ix-head" },
            h("span", { className: "ix-muted" }, [t("models.selected", { count: ids.filter((id) => draft.has(id)).length, total: ids.length }), fetched].filter(Boolean).join(" · ")),
            h("span", { className: "ix-spacer" }),
            gateway && !words.length ? h("button", { type: "button", className: "ix-link", onClick: () => setOpen(allOpen ? new Set() : new Set(groups.map((group) => group.id))) }, allOpen ? t("models.foldAll") : t("models.unfoldAll")) : null,
            searchable ? h("input", { className: "ix-text ix-search", type: "search", value: query, placeholder: t("models.search"), "aria-label": t("models.search"), spellCheck: false, onChange: (event) => setQuery(event.target.value) }) : null,
            searchable && words.length ? h("span", { className: "ix-muted" }, t("models.shown", { shown: shown.length })) : null,
            models?.live !== false ? h(P.Button, {
              className: "ix-btn",
              size: "sm",
              variant: "outline",
              icon: h(P.IconRefreshOutlineRegular, { size: 14 }),
              disabled: busy !== null,
              onClick: () => void act("fetch", "refreshModels", { endpoint: endpoint.id }, (value) => {
                const fresh = value?.models?.[endpoint.id]?.options;
                if (fresh) setDraft(new Set(fresh.filter((entry) => entry.enabled && !entry.blocked).map((entry) => entry.id)));
              }),
            }, busy === "fetch" ? t("models.fetching") : t("models.fetch")) : null),
          h("div", { className: "ix-model-groups" }, groups.map(section)),
          error ? h("div", { className: "ix-error", role: "alert" }, t("error.generic", { message: error })) : null),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "ix-btn", size: "sm", variant: "ghost", onClick: () => setDraft(new Set([...draft, ...shownIds])) }, t("models.all")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "ghost", onClick: () => setDraft(new Set([...draft].filter((id) => !shownIds.includes(id)))) }, t("models.none")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "ghost", disabled: busy !== null, onClick: () => void act("reset", "updateSettings", { endpoint: endpoint.id, enabledModelIds: null }, onClose) }, t("models.reset")),
          h("span", { className: "ix-spacer" }),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", onClick: onClose }, t("models.cancel")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "primary", disabled: busy !== null, onClick: () => void act("save", "updateSettings", { endpoint: endpoint.id, enabledModelIds: ids.filter((id) => draft.has(id)) }, onClose) }, t("models.save"))),
      });
    }

    function EditKeyDialog({ t, keyInfo: key, endpoint, onClose }) {
      const [label, setLabel] = React.useState(key.label ?? "");
      const gatewayParam = endpoint?.params?.find((param) => param.id === "gateway");
      const [gateway, setGateway] = React.useState(key.params?.gateway ?? "");
      const [working, setWorking] = React.useState(false);
      const [error, setError] = React.useState(null);
      const save = async () => {
        setWorking(true);
        setError(null);
        try {
          await run("updateKey", { keyId: key.id, label: label.trim() || null, ...(gatewayParam ? { params: { gateway: gateway.trim() || null } } : {}) });
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setWorking(false);
        }
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!working) onClose(); },
        title: t("edit.title", { masked: key.masked }),
        closeLabel: t("edit.cancel"),
        className: "ix-modal",
        contentClassName: "ix-modal-content",
        children: h("div", { className: "ix-dialog" },
          h("div", { className: "ix-field" },
            h("label", { htmlFor: `ix-edit-label-${key.id}` }, t("edit.label")),
            h("input", { id: `ix-edit-label-${key.id}`, className: "ix-text", value: label, maxLength: 60, onChange: (event) => setLabel(event.target.value), "data-modal-autofocus": true })),
          gatewayParam ? h("div", { className: "ix-field" },
            h("label", { htmlFor: `ix-edit-gateway-${key.id}` }, t("add.optional", { label: gatewayParam.label })),
            h("input", { id: `ix-edit-gateway-${key.id}`, className: "ix-text", value: gateway, maxLength: 64, spellCheck: false, onChange: (event) => setGateway(event.target.value) })) : null,
          error ? h("div", { className: "ix-error", role: "alert" }, t("error.generic", { message: error })) : null),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: working, onClick: onClose }, t("edit.cancel")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "primary", disabled: working, onClick: () => void save() }, t("edit.save"))),
      });
    }

    /**
     * One vendor's add-keys dialog: paste (or a file) and that vendor's own
     * DSH keys; detection tries this vendor's endpoints only, and a key that is
     * plainly another vendor's is pointed at its tab.
     */
    function AddKeysDialog({ t, status, vendor, onClose }) {
      const [endpoint, setEndpoint] = React.useState("auto");
      const [text, setText] = React.useState("");
      const [label, setLabel] = React.useState("");
      const [working, setWorking] = React.useState(false);
      const [lines, setLines] = React.useState([]);
      const picker = React.useRef(null);
      const tab = tabName(vendor);
      const endpoints = (status?.endpoints ?? []).filter((item) => item.vendor === vendor);
      // Cloudflare: the account (and gateway) the pasted keys work in; a line of the paste may name its own.
      const paramDefs = endpoints.find((item) => item.params)?.params ?? [];
      const [params, setParams] = React.useState({});
      const given = () => {
        const out = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value).trim()]).filter(([, value]) => value));
        return Object.keys(out).length ? { params: out } : {};
      };
      const submit = async (method, request) => {
        setWorking(true);
        setLines([]);
        try {
          const value = await run(method, { vendor, ...request });
          const out = (value?.added ?? []).map((result) => addLine(t, result));
          if (method === "importDshKeys") out.unshift({ tone: "muted", text: value?.refs?.length ? t("add.dshFound", { refs: value.refs.join(", ") }) : t("add.dshNone") });
          setLines(out);
          if (method === "addKeys" && out.some((line) => line.tone === "ok")) setText("");
        } catch (error) {
          setLines([{ tone: "error", text: t("error.generic", { message: String(error?.message ?? error) }) }]);
        } finally {
          setWorking(false);
        }
      };
      const add = () => submit("addKeys", { text, ...(endpoint !== "auto" ? { endpoint } : {}), ...(label.trim() ? { label: label.trim() } : {}), ...given() });
      /** Read a key file in the page; only its text reaches the host. */
      const fromFile = async (fileList) => {
        const file = [...(fileList ?? [])][0];
        if (!file) return;
        if (file.size > MAX_FILE_BYTES) {
          setLines([{ tone: "error", text: t("add.tooLarge", { name: file.name }) }]);
          return;
        }
        const content = await file.text();
        await submit("addKeys", { text: content, source: "file", ...(endpoint !== "auto" ? { endpoint } : {}), ...given() });
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!working) onClose(); },
        title: t("add.title", { vendor: tab }),
        closeLabel: t("add.close"),
        className: "ix-modal ix-modal-wide",
        contentClassName: "ix-modal-content",
        children: h("div", { className: "ix-dialog" },
          h("div", { className: "ix-field" },
            h("label", { htmlFor: "ix-add-endpoint" }, t("add.endpoint")),
            h("select", { id: "ix-add-endpoint", className: "ix-select", value: endpoint, onChange: (event) => setEndpoint(event.target.value) },
              h("option", { value: "auto" }, t("add.auto")),
              endpoints.map((item) => h("option", { key: item.id, value: item.id }, `${item.name} · ${item.host}`)))),
          paramDefs.map((param) => h("div", { key: param.id, className: "ix-field" },
            h("label", { htmlFor: `ix-add-param-${param.id}` }, param.required ? param.label : t("add.optional", { label: param.label })),
            h("input", { id: `ix-add-param-${param.id}`, className: "ix-text", value: params[param.id] ?? "", maxLength: 64, spellCheck: false, autoComplete: "off", onChange: (event) => setParams({ ...params, [param.id]: event.target.value }) }))),
          h("textarea", { className: "ix-textarea", value: text, placeholder: t("add.paste"), "aria-label": t("add.paste"), spellCheck: false, autoComplete: "off", "data-modal-autofocus": true, onChange: (event) => setText(event.target.value) }),
          h("div", { className: "ix-field" },
            h("label", { htmlFor: "ix-add-label" }, t("add.label")),
            h("input", { id: "ix-add-label", className: "ix-text", value: label, maxLength: 60, onChange: (event) => setLabel(event.target.value) })),
          h("div", { className: "ix-inline" },
            h(P.Button, { className: "ix-btn", size: "sm", variant: "primary", disabled: working || !text.trim(), onClick: () => void add() }, working ? t("add.working") : t("add.submit")),
            h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: working, onClick: () => picker.current?.click() }, t("add.file")),
            h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: working, onClick: () => void submit("importDshKeys", {}) }, t("add.dsh")),
            h("input", {
              ref: picker,
              type: "file",
              style: { display: "none" },
              onChange: (event) => {
                const target = event.target;
                void fromFile(target.files).finally(() => { target.value = ""; });
              },
            })),
          lines.length ? h("div", { className: "ix-results", role: "status" }, lines.map((line, index) => h("div", { key: index, className: line.tone === "ok" ? "ix-ok" : line.tone === "warn" ? "ix-warn" : line.tone === "muted" ? "ix-muted" : "ix-error" }, line.text))) : null),
        footer: h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: working, onClick: onClose }, t("add.close")),
      });
    }

    /** Which vendor tabs are shown (at least one). */
    function TabsDialog({ t, status, onClose }) {
      const hidden = status?.hiddenVendors ?? [];
      const [shown, setShown] = React.useState(() => new Set(VENDOR_TABS.map(([id]) => id).filter((id) => !hidden.includes(id))));
      const [working, setWorking] = React.useState(false);
      const [error, setError] = React.useState(null);
      const toggle = (id, next) => {
        const set = new Set(shown);
        if (next) set.add(id);
        else set.delete(id);
        setShown(set);
      };
      const save = async () => {
        setWorking(true);
        setError(null);
        try {
          await run("updateSettings", { hiddenVendors: VENDOR_TABS.map(([id]) => id).filter((id) => !shown.has(id)) });
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setWorking(false);
        }
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!working) onClose(); },
        title: t("tabs.title"),
        closeLabel: t("tabs.close"),
        className: "ix-modal",
        contentClassName: "ix-modal-content",
        children: h("div", { className: "ix-dialog" },
          VENDOR_TABS.map(([id, tab]) => {
            const count = keysOf(status, id).length;
            const last = shown.has(id) && shown.size === 1;
            return h("div", { key: id, className: "ix-inline ix-tabrow" },
              h(P.Switch, { checked: shown.has(id), label: tab, disabled: working || last, title: last ? t("tabs.last") : t("tabs.switchTitle"), onChange: (next) => toggle(id, next) }),
              h("span", { className: "ix-tabname" }, tab),
              h("span", { className: "ix-muted" }, [status?.vendors?.find((vendor) => vendor.id === id)?.name, count ? t("tabs.keys", { count }) : null].filter((part) => part && part !== tab).join(" · ")));
          }),
          error ? h("div", { className: "ix-error", role: "alert" }, t("error.generic", { message: error })) : null),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: working, onClick: onClose }, t("tabs.cancel")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "primary", disabled: working || shown.size === 0, onClick: () => void save() }, t("tabs.save"))),
      });
    }

    function EndpointSection({ t, endpoint, keys, models, drag, onModels, onEdit }) {
      const options = models?.options ?? [];
      const enabled = options.filter((entry) => entry.enabled && !entry.unusable).length;
      // Only the column this endpoint has: a balance, plan windows, or neither.
      const column = endpoint.showsBalance ? "balance" : endpoint.showsQuota ? "quota" : null;
      return h("section", { className: "ix-section", "aria-label": endpoint.name, "data-funds": column ?? "none" },
        h("div", { className: "ix-section-head" },
          // The plan terms live in a tooltip: on the plan tag, else on the name.
          h("span", { className: "ix-section-name", title: !endpoint.plan && endpoint.terms ? endpoint.terms : undefined }, endpoint.name),
          endpoint.plan ? h("span", { className: "ix-tag", "data-tone": "plan", title: [endpoint.plan, endpoint.terms].filter(Boolean).join(" — ") }, t("section.plan")) : null,
          h("span", { className: "ix-muted" }, endpoint.host),
          h("span", { className: "ix-spacer" }),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "ghost", title: t("section.modelsTitle"), onClick: onModels }, t("section.models", { count: enabled, total: options.filter((entry) => !entry.blocked).length }))),
        h("div", { className: "ix-grid ix-thead", "aria-hidden": true },
          h("span", null, t("col.status")),
          column ? h("span", null, t(column === "balance" ? "col.balance" : "col.quota")) : null,
          h("span", null, t("col.usage")),
          h("span", null, "")),
        h("ul", { style: { listStyle: "none", margin: 0, padding: 0 } }, keys.map((key) => h(KeyRow, { key: key.id, t, keyInfo: key, endpoint, column, drag: drag(endpoint.id, keys, key), onEdit }))));
    }

    /** One vendor's tab: its endpoints with keys, its switching settings, its checks and export, its notice. */
    function VendorPanel({ t, vendor }) {
      useWatch({ vendor });
      const state = useCn();
      const [adding, setAdding] = React.useState(false);
      const [tabs, setTabs] = React.useState(false);
      const [editing, setEditing] = React.useState(null);
      const [choosing, setChoosing] = React.useState(null);
      const [settingsError, setSettingsError] = React.useState(null);
      const [exporting, setExporting] = React.useState(false);
      const [exported, setExported] = React.useState(null);
      // Drag order within one endpoint.
      const [dragging, setDragging] = React.useState(null);
      const [dropAt, setDropAt] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const status = state.status;
      const tab = tabName(vendor);
      const settings = status?.vendorSettings?.[vendor] ?? { autoSwitch: status?.autoSwitch !== false, rotateOnRateLimit: status?.rotateOnRateLimit === true };
      const groups = groupsOf(status).filter((group) => group.endpoint.vendor === vendor).map((group) => {
        if (!pending || pending.endpoint !== group.endpoint.id) return group;
        const byId = new Map(group.keys.map((key) => [key.id, key]));
        return { ...group, keys: [...pending.ids.map((id) => byId.get(id)).filter(Boolean), ...group.keys.filter((key) => !pending.ids.includes(key.id))] };
      });
      const vendorKeys = keysOf(status, vendor);
      // A hold that ran out (plan window reset, balance maybe topped up): re-check
      // those keys for free, and wake up when the next hold ends.
      const rechecked = React.useRef(new Map());
      React.useEffect(() => {
        if (!status) return undefined;
        const now = Date.now();
        const free = new Set((status.endpoints ?? []).filter((endpoint) => endpoint.freeCheck).map((endpoint) => endpoint.id));
        const lapsed = vendorKeys.filter((key) => (key.status === "plan-quota" || key.status === "no-balance") && !key.limitedUntil && free.has(key.endpoint)
          && now - (rechecked.current.get(key.id) ?? 0) > 10 * 60_000);
        if (lapsed.length) {
          for (const key of lapsed) rechecked.current.set(key.id, now);
          void run("checkKeys", { keyIds: lapsed.map((key) => key.id) }).catch(() => undefined);
        }
        const ends = vendorKeys.map((key) => (key.limitedUntil ? Date.parse(key.limitedUntil) : NaN)).filter((at) => at > now);
        if (!ends.length) return undefined;
        const wait = Math.min(...ends) - now + 3_000;
        if (wait > 6 * 3_600_000) return undefined;
        const timer = setTimeout(() => void loadStatus(), wait);
        return () => clearTimeout(timer);
      }, [status]);
      const keyCount = vendorKeys.length;
      const hasFunds = vendorKeys.some((key) => key.funds);
      const commitOrder = (endpointId, next) => {
        if (!next) return;
        setPending({ endpoint: endpointId, ids: next });
        run("reorderKeys", { endpoint: endpointId, keyIds: next }).catch((error) => setSettingsError(String(error?.message ?? error))).finally(() => setPending(null));
      };
      const endDrag = () => {
        setDragging(null);
        setDropAt(null);
      };
      const drag = (endpointId, keys, key) => {
        const ids = keys.map((item) => item.id);
        const sameEndpoint = dragging?.endpoint === endpointId;
        return {
          enabled: keys.length > 1,
          dragging: dragging?.id === key.id,
          drop: sameEndpoint && dropAt?.id === key.id && dragging.id !== key.id ? (dropAt.after ? "after" : "before") : null,
          onMove: (delta) => commitOrder(endpointId, moved(ids, key.id, delta)),
          onDragStart: (event) => {
            event.stopPropagation?.();
            try {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", key.id);
              const row = event.currentTarget?.closest?.("li");
              if (row) event.dataTransfer.setDragImage(row, 24, 20);
            } catch {
              /* a minimal DataTransfer still drags */
            }
            setDragging({ endpoint: endpointId, id: key.id });
          },
          onDragEnd: endDrag,
          onDragOver: (event) => {
            if (!sameEndpoint) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            if (dropAt?.id !== key.id || dropAt.after !== after) setDropAt({ id: key.id, after });
          },
          onDrop: (event) => {
            if (!sameEndpoint) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            commitOrder(endpointId, reordered(ids, dragging.id, key.id, event.clientY > rect.top + rect.height / 2));
            endDrag();
          },
        };
      };
      const setting = (patch) => {
        setSettingsError(null);
        run("updateSettings", { vendor, ...patch }).catch((error) => setSettingsError(String(error?.message ?? error)));
      };
      /** This tab's keys to a text file in Downloads (`Vendor: key` lines). */
      const exportKeys = async () => {
        setExporting(true);
        setSettingsError(null);
        try {
          setExported(await call("exportKeys", { vendor }));
        } catch (error) {
          setSettingsError(String(error?.message ?? error));
        } finally {
          setExporting(false);
        }
      };
      const endpointOf = (id) => status?.endpoints?.find((item) => item.id === id);
      const keyName = (id) => {
        const key = status?.keys?.find((item) => item.id === id);
        return key ? keyTitle(key) : "—";
      };
      const last = status?.lastSwitches?.[vendor];
      const switched = last && last.at !== dismissedSwitch && Date.now() - Date.parse(last.at) < SWITCH_NOTICE_MS ? last : null;
      const checking = state.checking[vendor];
      const choosingGroup = choosing ? groups.find((group) => group.endpoint.id === choosing) : null;
      const editingKey = editing ? status?.keys?.find((key) => key.id === editing) : null;
      return h("div", { className: "ix-root" },
        h("div", { className: "ix-head" },
          h("span", { className: "ix-title" }, t("head.title", { vendor: tab })),
          h("span", { className: "ix-spacer" }),
          status === null ? null : h("span", { className: "ix-switch", title: t("head.autoSwitchHint") },
            h(P.Switch, { checked: settings.autoSwitch, label: t("head.autoSwitch"), onChange: (next) => setting({ autoSwitch: next }) }),
            h("span", null, t("head.autoSwitch"))),
          status === null ? null : h("span", { className: "ix-switch", title: t("head.rotateHint") },
            h(P.Switch, { checked: settings.rotateOnRateLimit, label: t("head.rotateOnRateLimit"), disabled: !settings.autoSwitch, onChange: (next) => setting({ rotateOnRateLimit: next }) }),
            h("span", null, t("head.rotateOnRateLimit"))),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", icon: h(ShieldIcon), title: t("head.validateHint"), disabled: Boolean(checking) || keyCount === 0, onClick: () => void checkVendor(vendor, { mode: "validity", deep: true }) }, checking === "validity" ? t("head.validating") : t("head.validate")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), title: t("head.fundsHint"), disabled: Boolean(checking) || !hasFunds, onClick: () => void checkVendor(vendor, { mode: "funds" }) }, checking === "funds" ? t("head.fundsing") : t("head.funds")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", disabled: exporting || keyCount === 0, onClick: () => void exportKeys() }, exporting ? t("head.exporting") : t("head.export")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "outline", title: t("head.tabsTitle"), onClick: () => setTabs(true) }, t("head.tabs")),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "primary", onClick: () => setAdding(true) }, t("head.add"))),
        exported ? h("div", { className: "ix-banner", role: "status" },
          h("span", null, t("head.exported", { count: exported.count, path: exported.path })),
          h("button", { type: "button", className: "ix-close", title: t("notice.dismiss"), "aria-label": t("notice.dismiss"), onClick: () => setExported(null) }, "×")) : null,
        switched ? h("div", { className: "ix-banner", role: "status" },
          h("span", null, t("notice.switched", {
            time: clock(switched.at),
            endpoint: endpointOf(switched.endpoint)?.name ?? switched.endpoint,
            from: keyName(switched.from),
            to: keyName(switched.to),
            reason: [switched.model, t(`reason.${switched.reason}`) === `reason.${switched.reason}` ? switched.reason : t(`reason.${switched.reason}`)].filter(Boolean).join(" · "),
          })),
          h("button", { type: "button", className: "ix-close", title: t("notice.dismiss"), "aria-label": t("notice.dismiss"), onClick: () => dismissSwitch(switched.at) }, "×")) : null,
        settingsError ? h("div", { className: "ix-error" }, t("error.generic", { message: settingsError })) : null,
        state.error ? h("div", { className: "ix-error", role: "alert" }, unavailableError(state.error) ? t("error.unavailable") : t("error.generic", { message: state.error })) : null,
        status !== null && keyCount === 0 ? h("div", { className: "ix-empty" },
          h("span", null, t("empty", { vendor: tab })),
          h(P.Button, { className: "ix-btn", size: "sm", variant: "primary", onClick: () => setAdding(true) }, t("head.add"))) : null,
        groups.map((group) => h(EndpointSection, {
          key: group.endpoint.id,
          t,
          endpoint: group.endpoint,
          keys: group.keys,
          models: status?.models?.[group.endpoint.id],
          drag,
          onModels: () => setChoosing(group.endpoint.id),
          onEdit: (key) => setEditing(key.id),
        })),
        adding ? h(AddKeysDialog, { t, status, vendor, onClose: () => setAdding(false) }) : null,
        tabs ? h(TabsDialog, { t, status, onClose: () => setTabs(false) }) : null,
        editingKey ? h(EditKeyDialog, { t, keyInfo: editingKey, endpoint: endpointOf(editingKey.endpoint), onClose: () => setEditing(null) }) : null,
        choosingGroup ? h(ModelsDialog, { t, endpoint: choosingGroup.endpoint, models: status?.models?.[choosingGroup.endpoint.id], onClose: () => setChoosing(null) }) : null);
    }

    /** One component per vendor tab (stable identities, so a re-registration keeps its state). */
    const VIEWS = new Map();
    function viewFor(vendor) {
      if (!VIEWS.has(vendor)) {
        const View = (props) => h("div", { className: "ix-view" }, h(VendorPanel, { ...props, vendor }));
        View.displayName = `CnModels(${tabName(vendor)})`;
        VIEWS.set(vendor, View);
      }
      return VIEWS.get(vendor);
    }

    /**
     * The card inside an endpoint's row of Settings → Models: that endpoint's
     * keys in one line. Keys are managed in the conversation tab.
     */
    function ProviderCard({ t, provider }) {
      useWatch({});
      const state = useCn();
      const route = provider?.provider ?? "";
      const endpointId = route.startsWith("intl-") ? route.slice(5) : null;
      const keys = (state.status?.keys ?? []).filter((key) => key.endpoint === endpointId);
      const active = keys.find((key) => key.active) ?? keys[0];
      const endpoint = state.status?.endpoints?.find((item) => item.id === endpointId);
      const line = state.status === null ? null : keys.length === 0 ? t("card.none") : t("card.summary", { count: keys.length, key: keyTitle(active), state: statusInfo(t, active, endpoint).label });
      return h("div", { className: "ix-summary" },
        unavailableError(state.error) ? h("span", { className: "ix-error" }, t("error.unavailable")) : line ? h("span", null, line) : null);
    }

    // ------------------------------------------------------------------ apply

    const METHODS = ["status", "checkKeys", "addKeys", "importDshKeys", "updateKey", "removeKey", "switchKey", "reorderKeys", "refreshModels", "updateSettings", "exportKeys"];
    const inert = (typeSymbol) => ({ mode: "strict", typeSymbol, create: () => ({ parse: (value) => value }) });
    const descriptors = METHODS.map((method) => ({
      id: `dsh-intl-models#intlModels/${method}`,
      service: "intlModelsKeys",
      namespace: "intlModels",
      method,
      invocation: { kind: "direct" },
      parameters: [{ name: "request", wire: "request", source: "json", codec: inert(`dsh-intl-models/types#${method}Request`) }],
      cancellation: { parameter: "signal" },
      result: inert(`dsh-intl-models/types#${method}Result`),
    }));

    async function apply(ctx) {
      installLocale(ctx);
      const remote = ctx.remote;
      if (remote !== undefined && typeof remote.$mount === "function" && ctx.get("remote.intlModels") === undefined) {
        const unmount = await remote.$mount({ package: "dsh-intl-models", descriptors });
        if (unmount !== undefined) ctx.effect(() => unmount, "dsh-intl-models: remote contribution");
      }
      call = async (method, request) => {
        const service = ctx.get("remote.intlModels");
        if (service === undefined || typeof service[method] !== "function") throw new Error("remote.intlModels is not mounted");
        const result = await service[method](request);
        if (result?.ok === true) return result.value;
        const code = typeof result?.error?.code === "string" ? ` (${result.error.code})` : "";
        throw new Error(`${String(result?.error?.message ?? "request failed")}${code}`);
      };
      const slots = ctx.slots;
      if (slots === undefined) return;
      // One tab per vendor (English labels), minus the hidden ones. The hidden
      // set lives on the host; this browser's copy lets the tabs appear at once.
      const tabs = new Map();
      let shown = null;
      const syncTabs = (hidden) => {
        const signature = hidden.join();
        if (shown === signature) return;
        shown = signature;
        VENDOR_TABS.forEach(([vendor, tab], index) => {
          const wanted = !hidden.includes(vendor);
          if (wanted && !tabs.has(vendor)) {
            tabs.set(vendor, slots.inject("conversation.view", () => slots.register({
              name: "conversation.view",
              id: `intl-${vendor}`,
              order: 41 + index,
              locale: NS,
              label: () => tab,
            }, viewFor(vendor))));
          } else if (!wanted && tabs.has(vendor)) {
            try {
              tabs.get(vendor)?.();
            } catch {
              /* already gone */
            }
            tabs.delete(vendor);
          }
        });
      };
      syncTabs(readHidden());
      const unsubscribe = subscribe(() => {
        const hidden = snapshot.status?.hiddenVendors;
        if (!Array.isArray(hidden)) return;
        writeHidden(hidden);
        syncTabs(hidden);
      });
      ctx.effect(() => () => {
        unsubscribe();
        for (const dispose of tabs.values()) {
          try {
            dispose?.();
          } catch {
            /* already gone */
          }
        }
        tabs.clear();
        shown = null;
      }, "dsh-intl-models: vendor tabs");
      // Learn the hidden tabs from the host even before a tab is opened.
      void loadStatus();
      ctx.effect(() => slots.inject("settings.models.provider-card", () => slots.register({
        name: "settings.models.provider-card",
        key: SETTINGS_NS,
        locale: NS,
      }, ProviderCard)), "dsh-intl-models: models card");
    }

    exports.name = "dsh-intl-models";
    exports.apply = apply;
    exports.inject = ["remote", "slots", "locale"];
    /** Pure helpers, exposed for the self-test only. */
    exports.__internals = Object.freeze({
      duration, clock, money, compact, isLow, freeOnly, modelVendor, priceText, statusInfo, addLine, groupsOf, reordered, moved, DICTS, METHODS, VENDOR_TABS,
      /** Seed the shared state (render tests). */
      seed: (patch) => update(patch),
    });
    return module.exports;
  },
});
