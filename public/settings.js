import { api, header, esc, toast, fmtDate, money } from './common.js';

const cfg = await header('settings');
const $ = (id) => document.getElementById(id);
let S = await api('/api/settings');
let AP = (await api('/api/autopilot')).autopilot;
const { types: TYPES } = await api('/api/business-types');
const TERMS = (d) => (d === 0 ? 'Due on receipt' : `Net ${d}`);
const STYLE = { warm: 'Warm', neutral: 'Neutral', brief: 'Brief' };

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'ILS', 'MXN', 'BRL', 'SGD', 'HKD', 'TWD', 'THB', 'PHP', 'MYR', 'CNY'];
const NOTIFY = [
  ['payment', 'Payments', 'A client paid, in full or in part'],
  ['overdue', 'Late invoices', 'An invoice just went past its due date'],
  ['due', 'Due soon', 'An invoice is due today or tomorrow'],
  ['approval', 'Drafts ready', 'Autopilot or a schedule wrote something for you to approve'],
  ['import', 'Imports', 'Invoices you created on paypal.com were picked up'],
];

// ---------------- fill forms ----------------
function fill() {
  const b = S.business;
  $('currency').innerHTML = CURRENCIES.map((c) => `<option ${c === b.currency ? 'selected' : ''}>${c}</option>`).join('');
  for (const k of ['businessName', 'ownerName', 'businessEmail', 'website', 'defaultTaxPercent', 'defaultNote', 'lateFeePercent', 'lateFeeAfterDays', 'signOff', 'aiInstructions']) if ($(k)) $(k).value = b[k] ?? '';
  const terms = $('defaultTermsDays');
  if (![...terms.options].some((o) => Number(o.value) === b.defaultTermsDays)) terms.insertAdjacentHTML('beforeend', `<option value="${b.defaultTermsDays}">Net ${b.defaultTermsDays}</option>`);
  terms.value = String(b.defaultTermsDays);
  document.querySelectorAll('[name=reminderStyle]').forEach((r) => (r.checked = r.value === (b.reminderStyle || 'warm')));
  $('notifyRows').innerHTML = NOTIFY.map(
    ([k, t, d]) => `<label class="set-row switch-row"><span class="lbl">${t}<span>${d}</span></span><input type="checkbox" class="switch" name="notify.${k}" ${b.notify?.[k] !== false ? 'checked' : ''}></label>`
  ).join('');
  renderAccount();
  renderTypes();
  renderPaypal(S.paypal);
  renderPlan();
  renderData();
}

// ---------------- account type ----------------
function renderAccount() {
  const t = S.business.accountType || 'freelancer';
  document.querySelectorAll('[name=acct]').forEach((r) => (r.checked = r.value === t));
  $('teamSize').value = S.business.teamSize || '2-10';
  syncAccount();
}
function syncAccount() {
  const v = document.querySelector('[name=acct]:checked')?.value || 'freelancer';
  $('teamRow').classList.toggle('hidden', v !== 'business');
  $('acctPresetWrap').classList.toggle('hidden', v === (S.business.accountType || 'freelancer'));
  document.querySelectorAll('.acct-card').forEach((el) => el.classList.toggle('on', el.querySelector('input').checked));
}
document.querySelectorAll('[name=acct]').forEach((r) => r.addEventListener('change', syncAccount));
$('acctSave').onclick = async () => {
  const v = document.querySelector('[name=acct]:checked')?.value || 'freelancer';
  const changed = v !== (S.business.accountType || 'freelancer');
  try {
    await api('/api/settings/business', { body: { accountType: v, teamSize: v === 'business' ? $('teamSize').value : '', applyPreset: changed && $('acctPreset').checked } });
    toast(v === 'business' ? 'Switched to the business layout' : 'Switched to the freelancer layout');
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    $('acctOk').textContent = err.message;
  }
};

// ---------------- what you do ----------------
function renderTypes() {
  const cur = S.business.businessType || 'graphic_designer';
  $('btSelect').innerHTML = TYPES.map((t) => `<option value="${t.key}" ${t.key === cur ? 'selected' : ''}>${esc(t.label)}${t.key === 'other' ? '' : ` · ${esc(t.blurb)}`}</option>`).join('');
  showPreset();
}
function showPreset() {
  const key = $('btSelect').value || 'graphic_designer';
  const t = TYPES.find((x) => x.key === key);
  const b = S.business;
  const same = b.defaultTermsDays === t.terms && b.reminderStyle === t.style && (b.defaultNote || '') === t.note;
  const otherVal = document.querySelector('[name=businessTypeOther]')?.value ?? S.business.businessTypeOther ?? '';
  $('btPreset').innerHTML = `${key === 'other' ? `<input class="bt-other-in" name="businessTypeOther" maxlength="40" value="${esc(otherVal)}" placeholder="Your profession, e.g. Interior designer" aria-label="Your profession">` : ''}
    <div class="bt-sum"><span>Usual: <b>${TERMS(t.terms)}</b> · <b>${STYLE[t.style]}</b> reminders · <b>${esc(t.retainer)}</b></span>${same ? '<em>in use</em>' : '<button type="button" class="linkbtn small" id="btApply">Use these</button>'}</div>
    <details class="bt-more"><summary>Invoice shortcuts for this work</summary><div class="bt-items">${t.items.map((i) => `<span>${esc(i.name)} · ${esc(money(i.price, cfg.currency))}</span>`).join('')}</div></details>`;
  $('btApply')?.addEventListener('click', async () => {
    await api('/api/settings/business', { body: { businessType: key, businessTypeOther: document.querySelector('[name=businessTypeOther]')?.value || '', applyPreset: true } });
    S = await api('/api/settings');
    toast(`Using ${t.label.toLowerCase()} defaults: ${TERMS(t.terms)}, ${STYLE[t.style].toLowerCase()} reminders`);
    fill();
  });
}
$('btSelect').addEventListener('change', showPreset);

// ---------------- generic section save ----------------
function collect(form) {
  const body = {};
  form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    if (el.type === 'radio') {
      if (el.checked) body[el.name] = el.value;
      return;
    }
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.name === 'defaultTermsDays' ? Number(el.value || 0) : el.value;
    if (el.name.startsWith('notify.')) (body.notify ||= {})[el.name.slice(7)] = v;
    else body[el.name] = v;
  });
  return body;
}
document.querySelectorAll('form[data-sec]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = form.querySelector('.set-ok');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/settings/business', { body: collect(form) });
      S = await api('/api/settings');
      ok.textContent = 'Saved';
      ok.classList.remove('err');
      form.classList.remove('dirty');
      setTimeout(() => (ok.textContent = ''), 1800);
    } catch (err) {
      ok.textContent = err.message;
      ok.classList.add('err');
    } finally {
      btn.disabled = false;
    }
  });
  form.addEventListener('input', () => form.classList.add('dirty'));
});

// ---------------- PayPal ----------------
function renderPaypal(p) {
  const on = p.mode !== 'mock';
  $('ppStatus').innerHTML = on
    ? `<div class="set-status on"><i class="dot"></i><div><b>Connected to PayPal ${p.mode === 'live' ? 'Live' : 'Sandbox'}</b><span>App ${esc(p.clientId)} · ${p.source === 'app' ? `connected ${p.connectedAt ? fmtDate(p.connectedAt.slice(0, 10)) : ''} in PayPilot` : 'keys from the .env file'}</span></div></div>`
    : `<div class="set-status off"><i class="dot"></i><div><b>Demo mode</b><span>Invoices are simulated inside PayPilot. Connect a PayPal sandbox app to send real test invoices.</span></div></div>`;
  $('ppForm').classList.toggle('hidden', on);
  $('ppFacts').innerHTML = on
    ? `<div><dt>Payment checks</dt><dd>Every 2 minutes, automatically</dd></div>
       <div><dt>Invoices made on paypal.com</dt><dd>Imported automatically</dd></div>
       <div><dt>Split payments (deposits)</dt><dd>Where PayPal allows it; otherwise added as a note</dd></div>`
    : '';
  $('ppActions').innerHTML = on ? `<button class="btn ghost" id="swapBtn" type="button">Use different keys</button><button class="btn ghost" id="discBtn" type="button">Disconnect</button>` : '';
  $('discBtn')?.addEventListener('click', async (e) => {
    if (!e.target.dataset.confirm) {
      e.target.dataset.confirm = '1';
      e.target.textContent = 'Click again to disconnect';
      return;
    }
    await api('/api/settings/paypal/disconnect', { body: {} });
    toast('PayPal disconnected. You are in demo mode now.');
    setTimeout(() => location.reload(), 700);
  });
  $('swapBtn')?.addEventListener('click', () => {
    $('ppForm').classList.remove('hidden');
    $('cid').focus();
  });
}
$('ppForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('ppErr').textContent = '';
  $('ppGo').disabled = true;
  $('ppGo').textContent = 'Checking with PayPal…';
  try {
    const r = await api('/api/settings/paypal/connect', { body: { clientId: $('cid').value, clientSecret: $('sec').value, sampleHistory: false } });
    toast(r.imported ? `Connected. ${r.imported} invoice${r.imported > 1 ? 's' : ''} imported from PayPal.` : 'Connected to PayPal');
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    $('ppErr').textContent = err.message;
  } finally {
    $('ppGo').disabled = false;
    $('ppGo').textContent = 'Connect PayPal';
  }
});

// ---------------- Autopilot ----------------
function renderPlan() {
  $('apToggle').setAttribute('aria-checked', String(AP.enabled));
  $('apToggle').classList.toggle('off', !AP.enabled);
  $('apLabel').textContent = AP.enabled ? 'On' : 'Off';
  $('autopilot').classList.toggle('ap-off', !AP.enabled);
  const fee = S.business.lateFeePercent;
  const num = (k, v, max) => `<input type="number" min="0" max="${max}" value="${v}" data-plan="${k}" aria-label="${k}">`;
  $('planSteps').innerHTML = `
    <li class="ps friendly"><span class="ps-dot"></span><div><b>Friendly heads-up</b><span>${num('beforeDays', AP.beforeDays, 14)} days <em>before</em> the due date</span></div></li>
    <li class="ps firm"><span class="ps-dot"></span><div><b>Firm reminder</b><span>${num('firmAfter', AP.firmAfter, 30)} days <em>after</em> the due date</span></div></li>
    <li class="ps final"><span class="ps-dot"></span><div><b>Final reminder</b><span>${num('finalAfter', AP.finalAfter, 90)} days <em>after</em> the due date</span>
      <label class="ps-fee"><input type="checkbox" data-plan="feeWithFinal" ${AP.feeWithFinal ? 'checked' : ''} ${fee > 0 ? '' : 'disabled'}> ${fee > 0 ? `add a ${fee}% late fee` : 'late fees are off (see Late fees)'}</label></div></li>`;
}
let planTimer;
$('planSteps').addEventListener('input', () => {
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    const body = {};
    document.querySelectorAll('[data-plan]').forEach((el) => (body[el.dataset.plan] = el.type === 'checkbox' ? el.checked : Number(el.value)));
    try {
      AP = (await api('/api/autopilot', { body })).autopilot;
      $('planSaved').textContent = 'Saved';
      $('planSaved').classList.remove('err');
      setTimeout(() => ($('planSaved').textContent = ''), 1500);
    } catch (err) {
      $('planSaved').textContent = err.message;
      $('planSaved').classList.add('err');
    }
  }, 600);
});
$('apToggle').onclick = async () => {
  AP = (await api('/api/autopilot', { body: { enabled: !AP.enabled } })).autopilot;
  if (AP.enabled) await api('/api/autopilot/run', { body: {} }).catch(() => {});
  toast(AP.enabled ? 'Autopilot on. It drafts reminders on the right days; you approve them.' : 'Autopilot off. Nothing is drafted unless you ask.');
  renderPlan();
};

// ---------------- AI writing preview ----------------
$('previewBtn').onclick = async (e) => {
  const b = e.currentTarget;
  const form = $('writing');
  b.disabled = true;
  b.textContent = 'Writing…';
  try {
    if (form.classList.contains('dirty')) {
      await api('/api/settings/business', { body: collect(form) });
      form.classList.remove('dirty');
    }
    const r = await api('/api/settings/preview-reminder', { body: {} });
    $('preview').innerHTML = `<div class="mail-preview"><div class="mp-head"><span class="pill ${esc(r.tone)}">${esc(r.tone)}</span><span class="muted">Preview for #${esc(r.number)} · ${esc(r.client)} · ${r.draftedBy === 'ai' ? 'written by AI' : 'template (AI unavailable)'} · not sent</span></div>
      <b>${esc(r.subject)}</b><p>${esc(r.message).replace(/\n/g, '<br>')}</p></div>`;
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Preview a reminder';
  }
};

// ---------------- Data ----------------
async function renderData() {
  const [{ invoices }, { clients }] = await Promise.all([api('/api/invoices'), api('/api/clients')]);
  const paid = invoices.filter((i) => ['PAID', 'MARKED_AS_PAID'].includes(i.status));
  const first = invoices.map((i) => i.issueDate).sort()[0];
  $('dataFacts').innerHTML = `
    <div><dt>Clients</dt><dd>${clients.length}</dd></div>
    <div><dt>Invoices</dt><dd>${invoices.length} (${paid.length} paid)</dd></div>
    <div><dt>History since</dt><dd>${first ? fmtDate(first) : '—'}</dd></div>
    <div><dt>Collected</dt><dd>${money(paid.reduce((t, i) => t + (i.currency === cfg.currency ? i.total : 0), 0), cfg.currency)}</dd></div>`;
  $('restoreSub').textContent = S.hiddenClients ? `${S.hiddenClients} removed client${S.hiddenClients > 1 ? 's' : ''} can be imported from PayPal again` : 'No removed clients';
  $('restoreBtn').disabled = !S.hiddenClients;
  const t = TYPES.find((x) => x.key === (S.business.businessType || 'graphic_designer')) || TYPES[1];
  $('resetSub').textContent = `Start over with sample clients and ${t.key === 'other' ? 'general' : t.label.toLowerCase()} work. Settings are kept.`;
  $('resetBtn').classList.toggle('hidden', S.paypal.mode !== 'mock');
  const sm = await api('/api/sample');
  $('sampleBtn').dataset.mode = sm.count ? 'remove' : 'add';
  $('sampleTitle').textContent = sm.count ? 'Remove sample data' : 'Add sample data';
  $('sampleSub').textContent = sm.count ? `${sm.count} sample invoice${sm.count === 1 ? '' : 's'} and ${sm.clients} sample client${sm.clients === 1 ? '' : 's'}. Your own invoices stay.` : 'A few sample clients and invoices to try things out. Remove them later in one click.';
  $('sampleBtn').classList.toggle('danger', Boolean(sm.count));
}
$('sampleBtn').onclick = async (e) => {
  const b = e.currentTarget;
  if (b.dataset.mode === 'remove') {
    if (!b.dataset.confirm) {
      b.dataset.confirm = '1';
      $('sampleTitle').textContent = 'Click again to remove the samples';
      return;
    }
    const r = await api('/api/sample/remove', { body: {} });
    toast(`Removed ${r.invoices} sample invoice${r.invoices === 1 ? '' : 's'} and ${r.clients} client${r.clients === 1 ? '' : 's'}`);
  } else {
    await api('/api/demo/seed', { body: {} });
    toast('Sample data added');
  }
  setTimeout(() => location.reload(), 700);
};
$('restoreBtn').onclick = async () => {
  const r = await api('/api/settings/hidden/clear', { body: {} });
  toast(`${r.restored} client${r.restored === 1 ? '' : 's'} restored. They'll come back with the next PayPal check.`);
  S = await api('/api/settings');
  renderData();
};
$('resetBtn').onclick = async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.confirm) {
    b.dataset.confirm = '1';
    b.querySelector('b').textContent = 'Click again to reset everything';
    return;
  }
  await api('/api/demo/reset', { body: {} });
  await api('/api/demo/seed', { body: {} });
  toast('Demo data reset');
  setTimeout(() => location.reload(), 700);
};

// ---------------- Security ----------------
function renderSecurity() {
  const on = cfg.loginEnabled;
  const env = cfg.passcodeFromEnv;
  $('secStatus').innerHTML = env
    ? `<div class="set-status on"><i class="dot"></i><div><b>Locked with a passcode</b><span>It's set by APP_PASSWORD in the .env file, so it can only be changed there.</span></div></div>`
    : on
      ? `<div class="set-status on"><i class="dot"></i><div><b>Locked with a passcode</b><span>You'll be asked for it after signing out or on a new device.</span></div></div>`
      : `<div class="set-status off"><i class="dot"></i><div><b>No passcode</b><span>Anyone who can open PayPilot can use it. Set one before you put it online.</span></div></div>`;
  ['secCurRow', 'secNewRow', 'secNew2Row'].forEach((id) => $(id).classList.toggle('hidden', env));
  $('secCurRow').classList.toggle('hidden', env || !on);
  $('secRemove').classList.toggle('hidden', env || !on);
  $('secSave').classList.toggle('hidden', env);
  $('secSave').textContent = on ? 'Change passcode' : 'Set passcode';
}
$('security').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = $('secOk');
  ok.classList.remove('err');
  if ($('secNew').value !== $('secNew2').value) {
    ok.textContent = "The two passcodes don't match";
    return ok.classList.add('err');
  }
  try {
    await api('/api/settings/passcode', { body: { current: $('secCur').value, passcode: $('secNew').value } });
    cfg.loginEnabled = true;
    ['secCur', 'secNew', 'secNew2'].forEach((id) => ($(id).value = ''));
    ok.textContent = 'Passcode saved. You can sign out from the sidebar.';
    renderSecurity();
  } catch (err) {
    ok.textContent = err.message;
    ok.classList.add('err');
  }
});
$('secRemove').onclick = async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.confirm) {
    b.dataset.confirm = '1';
    b.textContent = 'Click again to remove';
    return;
  }
  try {
    await api('/api/settings/passcode', { body: { current: $('secCur').value, remove: true } });
    cfg.loginEnabled = false;
    $('secOk').textContent = 'Passcode removed';
    renderSecurity();
  } catch (err) {
    $('secOk').textContent = err.message;
    $('secOk').classList.add('err');
  }
  delete b.dataset.confirm;
  b.textContent = 'Remove passcode';
};

// ---------------- section nav ----------------
const links = [...document.querySelectorAll('#setNav a')];
function markActive() {
  let cur = links[0];
  for (const a of links) {
    const sec = document.querySelector(a.getAttribute('href'));
    if (sec && sec.getBoundingClientRect().top < 140) cur = a;
  }
  links.forEach((a) => a.toggleAttribute('aria-current', a === cur));
}
window.addEventListener('scroll', markActive, { passive: true });

fill();
renderSecurity();
markActive();
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
