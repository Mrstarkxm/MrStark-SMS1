// ---- Mock demo data (still mock in Phase 2 - Payouts/Rates land in Phase 3) ----
const mock = {
  payouts: [
    ['PAY-1001', '2026-09-07', '$48.20', 'USDT', 'Completed'],
    ['PAY-1000', '2026-08-31', '$76.30', 'USDT', 'Completed'],
  ],
};

let currentUser = null;

let separateCountryCode = false;

const COUNTRY_CALLING_CODES = [
  '1','7','20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49',
  '51','52','53','54','55','56','57','58','60','61','62','63','64','65','66','81','82','84','86','90',
  '91','92','93','94','95','98','211','212','213','216','218','220','221','222','223','224','225','226',
  '227','228','229','230','231','232','233','234','235','236','237','238','239','240','241','242','243',
  '244','245','246','248','249','250','251','252','253','254','255','256','257','258','260','261','262',
  '263','264','265','266','267','268','269','290','291','297','298','299','350','351','352','353','354',
  '355','356','357','358','359','370','371','372','373','374','375','376','377','378','379','380','381',
  '382','383','385','386','387','389','420','421','423','500','501','502','503','504','505','506','507',
  '508','509','590','591','592','593','594','595','596','597','598','599','670','672','673','674','675',
  '676','677','678','679','680','681','682','683','685','686','687','688','689','690','691','692','800',
  '808','850','852','853','855','856','880','886','960','961','962','963','964','965','966','967','968',
  '970','971','972','973','974','975','976','977','992','993','994','995','996','998'
].sort((a,b)=>b.length-a.length);

function splitCountryCode(value) {
  let raw = String(value || '').trim();
  let digits = raw.replace(/[^\d]/g, '');
  for (const code of COUNTRY_CALLING_CODES) {
    if (digits.startsWith(code) && digits.length > code.length + 4) {
      return { cc: `+${code}`, number: digits.slice(code.length) };
    }
  }
  return { cc: '', number: raw.replace(/^\+/, '') };
}

const content = document.getElementById('content');
const title = document.getElementById('title');

function table(headers, rows) {
  return `<div class="table-wrap"><table class="table"><thead><tr>${headers
    .map((h) => `<th>${h}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function statusPill(status) {
  const cls = status === 'active' || status === 'Active' || status === 'Delivered' || status === 'Completed'
    ? 'active' : (status === 'suspended' || status === 'Suspended' || status === 'Failed' ? 'suspended' : '');
  return `<span class="pill ${cls}">${status}</span>`;
}

function roleBadge(role) {
  const label = { super_admin: 'Super Admin', manager: 'Manager', agent: 'Agent', admin: 'Agent', client: 'Client' }[role] || role;
  return `<span class="badge role-${role}">${label}</span>`;
}

// ---------- Modal helper ----------
function openModal(innerHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modalOverlay';
  overlay.innerHTML = `<div class="modal">${innerHtml}</div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
}
function closeModal() {
  const el = document.getElementById('modalOverlay');
  if (el) el.remove();
}

// ---------- Dashboard (earnings report) ----------
async function dashboardPage() {
  content.innerHTML = `<div class="empty">Loading dashboard...</div>`;
  try {
    const res = await fetch('/api/dashboard/stats?_=' + Date.now(), {cache:'no-store'});
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Could not load dashboard');
    const today=d.today||{}, week=d.week||{}, month=d.month||{};
    const isClient=currentUser.role==='client';
    const payoutLabel=isClient?'Client Payout':'My Payout';
    const payoutCards=[
      `<div class="card"><div class="label">Today Payout</div><div class="value">$${Number(today.payout||0).toFixed(3)}</div><div class="up">${payoutLabel}</div></div>`,
      `<div class="card"><div class="label">Available Payout</div><div class="value">$${Number(week.payout||0).toFixed(3)}</div><div class="up">Wednesday → now</div></div>`,
      `<div class="card"><div class="label">This Month Payout</div><div class="value">$${Number(month.payout||0).toFixed(3)}</div><div class="up">Current month</div></div>`
    ].join('');
    const balanceCard=currentUser.role!=='super_admin'
      ? `<div class="card"><div class="label">Your Balance</div><div class="value">$${Number(d.balance||0).toFixed(2)}</div><div class="up">Available</div></div>`
      : `<div class="card"><div class="label">Profit</div><div class="value">$${(Number(month.payout||0)-Number(month.clientPayout||0)).toFixed(3)}</div><div class="up">This month</div></div>`;
    const days=[]; for(let i=6;i>=0;i--){const x=new Date();x.setHours(0,0,0,0);x.setDate(x.getDate()-i);days.push(x);}
    // Keep the dashboard chart lightweight: only request the summary stats above.
    content.innerHTML=`
      <div class="grid">
        <div class="card"><div class="label">Today SMS</div><div class="value">${Number(today.sms||0)}</div><div class="up">${Number(today.successful||0)} successful</div></div>
        <div class="card"><div class="label">This Week SMS</div><div class="value">${Number(week.sms||0)}</div><div class="up">Wednesday → now</div></div>
        <div class="card"><div class="label">This Month SMS</div><div class="value">${Number(month.sms||0)}</div><div class="up">Current month</div></div>
        ${payoutCards}
        <div class="card"><div class="label">Active Numbers</div><div class="value">${Number(d.activeNumbers||0)}</div><div class="up">Showing inventory</div></div>
        ${balanceCard}
      </div>
      <div class="card earnings-chart-card"><div class="toolbar" style="justify-content:space-between;align-items:center"><div><h3 style="margin:0">Earnings Report</h3><div class="muted">Last 7 days · ${payoutLabel}</div></div></div><div class="empty" style="margin-top:12px">Dashboard summary is optimized for fast loading.</div></div>`;
  } catch(e) { console.error(e); content.innerHTML=`<div class="empty">Could not load dashboard.</div>`; }
}

// ---------- Carrier page (Lamix REST integration) ----------
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); }
async function carrierPage() {
  content.innerHTML = `<div class="empty">Loading carrier status...</div>`;
  const res = await fetch('/api/carrier/status');
  const data = await res.json();
  if (!res.ok) {
    content.innerHTML = `<div class="empty">${data.error || 'Could not load carrier status'}</div>`;
    return;
  }

  const state = data.configured ? 'Configured' : 'Not configured';
  const stateClass = data.configured ? 'active' : 'suspended';
  const last = data.lastResult;
  const lastText = last
    ? (last.skipped
      ? `Sync in progress — ${last.reason || 'please wait'}`
      : `${last.syncedAt ? new Date(last.syncedAt).toLocaleString() : 'Unknown time'} — ${Number(last.numbersImported ?? 0)} numbers imported, ${Number(last.cdrsImported ?? 0)} CDRs imported`)
    : 'No sync has run yet';

  content.innerHTML = `
    <div class="grid">
      <div class="card"><div class="label">Lamix</div><div class="value"><span class="pill ${stateClass}">${state}</span></div><div class="up">${data.baseUrl}</div></div>
      <div class="card"><div class="label">Polling</div><div class="value">${Math.round(Number(data.pollIntervalMs) / 1000)}s</div><div class="up">Automatic background sync${data.vercel ? ' while Super Admin panel is open' : ''}</div></div>
      <div class="card"><div class="label">Last Sync</div><div class="value" style="font-size:18px">${lastText}</div><div class="up">Numbers + CDR feed</div></div>
    </div>

    <h3 class="section-title">Lamix REST carrier</h3>
    <div class="card">
      <p><b>Connected endpoints:</b> <code>/ranges</code>, <code>/numbers</code>, <code>/cdrs</code></p>
      <p class="muted">Lamix ranges are imported first, and every number remains linked to its carrier range. Super Admin assigns ranges to Agents; Agents/Managers then distribute available numbers to Clients. CDRs are matched by MSISDN and only credited when that number is assigned to a Client. Duplicate CDRs are ignored.</p>
      <p class="muted">The API token is intentionally not stored in the project or shown in this panel. Configure it as <code>LAMIX_API_TOKEN</code> on the server.</p>
      <div class="toolbar" style="margin-top:14px">
        <button class="btn" id="testLamixBtn" ${data.configured ? '' : 'disabled'}>Test Connection</button>
        <button class="btn primary" id="syncLamixBtn" ${data.configured ? '' : 'disabled'}>Sync Now</button>
      </div>
      <div class="auth-error" id="carrierError"></div>
      <div id="carrierResult" class="muted" style="margin-top:12px"></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="margin-top:0">Manual Number Import</h3>
      <p class="muted">Super Admin can upload a TXT/CSV file with one number per line and create a separate manual range for those numbers.</p>
      <div class="toolbar" style="gap:10px;flex-wrap:wrap">
        <input class="input" id="manualRangeName" placeholder="Range name" style="min-width:220px">
        <input class="input" id="manualCountry" placeholder="Country (optional)" style="min-width:180px">
        <input class="input" id="manualOperator" placeholder="Operator (optional)" style="min-width:180px">
        <input type="file" id="manualNumbersFile" accept=".txt,.csv,text/plain,text/csv" class="input" style="max-width:320px">
        <button class="btn primary" id="manualImportBtn">Import Numbers</button>
      </div>
      <div class="muted" id="manualImportResult" style="margin-top:10px"></div>
    </div>
  `;

  const errorEl = document.getElementById('carrierError');
  const resultEl = document.getElementById('carrierResult');
  const testBtn = document.getElementById('testLamixBtn');
  const syncBtn = document.getElementById('syncLamixBtn');
  const manualBtn = document.getElementById('manualImportBtn');
  manualBtn.onclick = async () => {
    const file = document.getElementById('manualNumbersFile').files[0];
    const name = document.getElementById('manualRangeName').value.trim();
    const result = document.getElementById('manualImportResult');
    if (!file) return alert('Select a TXT or CSV file first.');
    if (!name) return alert('Enter a range name.');
    manualBtn.disabled = true; result.textContent = 'Reading file and importing…';
    try {
      const text = await file.text();
      const numbers = text.split(/\r?\n/).flatMap(line => line.split(/[,;\t]/)).map(x => x.trim().replace(/^['\"]|['\"]$/g,'')).filter(Boolean);
      const r = await fetch('/api/manual-import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,country:document.getElementById('manualCountry').value.trim(),operator:document.getElementById('manualOperator').value.trim(),numbers})});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Import failed');
      result.textContent = `Imported ${d.imported} numbers into “${d.range.name}”; skipped ${d.skipped || 0} duplicates/invalid rows.`;
      document.getElementById('manualNumbersFile').value='';
      setTimeout(() => render('carrier'), 900);
    } catch(e) { result.textContent = e.message || 'Import failed'; } finally { manualBtn.disabled=false; }
  };

  testBtn.onclick = async () => {
    testBtn.disabled = true;
    resultEl.textContent = 'Testing Lamix...';
    const r = await fetch('/api/carrier/test', { method: 'POST' });
    const d = await r.json();
    testBtn.disabled = false;
    if (!r.ok) {
      errorEl.textContent = d.error || 'Connection test failed';
      errorEl.classList.add('show');
      resultEl.textContent = '';
      return;
    }
    errorEl.classList.remove('show');
    resultEl.textContent = `Connection OK — ${d.ranges} ranges available.`;
  };

  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    testBtn.disabled = true;
    errorEl.classList.remove('show');
    resultEl.textContent = 'Syncing ranges, numbers and CDRs...';
    const r = await fetch('/api/carrier/sync', { method: 'POST' });
    const d = await r.json();
    syncBtn.disabled = false;
    testBtn.disabled = false;
    if (!r.ok) {
      errorEl.textContent = d.error || 'Sync failed';
      errorEl.classList.add('show');
      resultEl.textContent = '';
      return;
    }
    if (d.skipped) {
      resultEl.textContent = `Sync not started — ${d.message || d.reason || 'another sync is already running'}.`;
      syncBtn.disabled = false;
      testBtn.disabled = false;
      // Stay on the Carrier page so the diagnostics remain visible; do not auto-reload.
      setTimeout(() => { if (document.getElementById('carrierResult')) render('carrier'); }, 1500);
      return;
    }
    const errors = d.errors && d.errors.length ? ` Errors: ${d.errors.join(' | ')}` : '';
    const nImp = Number(d.numbersImported ?? 0);
    const nUpd = Number(d.numbersUpdated ?? 0);
    const cImp = Number(d.cdrsImported ?? 0);
    const cUpd = Number(d.cdrsUpdated ?? 0);
    const cSkip = Number(d.cdrsSkipped ?? 0);
    const nFetch = Number(d.numbersFetched ?? 0);
    const cFetch = Number(d.cdrsFetched ?? 0);
    const diag = Array.isArray(d.cdrDiagnostics) ? d.cdrDiagnostics : [];
    const numDiag = Array.isArray(d.numberDiagnostics) ? d.numberDiagnostics : [];
    const diagText = diag.length ? ' CDR probe: ' + diag.map(x => `${x.path}=${x.ok ? `${x.rows} rows` : `ERR ${x.status || ''} ${x.error || ''}`}`).join(' | ') : '';
    resultEl.innerHTML = `Done — fetched ${nFetch} numbers, imported ${nImp}, updated ${nUpd}; fetched ${cFetch} CDRs, imported ${cImp}, updated ${cUpd}, skipped ${cSkip}.${errors}<br><br><b>Number probe diagnostics</b><br><pre style="white-space:pre-wrap;max-height:360px;overflow:auto;margin-top:8px">${escapeHtml(numDiag.length ? JSON.stringify(numDiag, null, 2) : 'No number diagnostics returned.')}</pre><br><b>CDR probe diagnostics</b><br><pre style="white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:8px">${escapeHtml(diag.length ? JSON.stringify(diag, null, 2) : 'No CDR diagnostics returned.')}</pre>`;
    // Do not immediately reload the whole page: it used to erase the diagnostic output
    // and could race with the 1s background CDR poll. Keep the result visible.

  };
}

function mockPage(name) {
  if (name === 'payouts') {
    return `<div class="toolbar"><input class="input" placeholder="Search..."><button class="btn primary">+ Add</button></div>${table(
      ['ID', 'Date', 'Amount', 'Method', 'Status'],
      mock.payouts.map(r => r.map((c,i)=> i===r.length-1?statusPill(c):c))
    )}`;
  }
  if (name === 'settings') {
    return `<div class="grid"><div class="card"><h3>Personal Details</h3><p class="muted">Your username is fixed and cannot be changed.</p><div class="field"><label>Username</label><input class="input" value="${currentUser.username}" disabled></div><div class="field"><label>Email (optional)</label><input class="input" id="profileEmail" type="email" value="${currentUser.email || ''}"></div><button class="btn primary" id="saveProfile">Save details</button><div class="auth-error" id="profileMsg"></div></div><div class="card"><h3>Change Password</h3><div class="field"><label>Current password</label><input class="input" id="currentPassword" type="password"></div><div class="field"><label>New password</label><input class="input" id="newPassword" type="password"></div><button class="btn primary" id="changePassword">Change password</button><div class="auth-error" id="passwordMsg"></div></div></div>`;
  }
  return `<div class="empty">Not found</div>`;
}

// ---------- Managers page (Super Admin only) ----------
async function managersPage() {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  const res = await fetch('/api/managers');
  const data = await res.json();
  if (!res.ok) { content.innerHTML = `<div class="empty">${data.error || 'Could not load managers'}</div>`; return; }
  const rows = data.managers.map(m => [m.username, m.email, `$${Number(m.balance||0).toFixed(2)}`, statusPill(m.status), `<button class="btn small" data-action="edit-manager-balance" data-id="${m.id}" data-balance="${Number(m.balance||0).toFixed(2)}">Balance</button> <button class="btn small ${m.status === 'active' ? 'danger' : ''}" data-action="toggle-manager" data-id="${m.id}" data-status="${m.status}">${m.status === 'active' ? 'Suspend' : 'Activate'}</button>`]);
  content.innerHTML = `<div class="toolbar"><span class="muted">Managers can create Agents and Clients. Only Super Admin can edit Manager balances.</span><button class="btn primary" id="addManagerBtn">+ Add Manager</button></div>${table(['Username','Email','Balance','Status','Actions'], rows)}`;
  document.getElementById('addManagerBtn').onclick = () => {
    openModal(`<h3>Create Manager</h3><div class="auth-error" id="modalError"></div><div class="field"><label>Username</label><input class="input" id="m_username"></div><div class="field"><label>Email (optional)</label><input class="input" id="m_email" type="email"></div><div class="field"><label>Password</label><input class="input" id="m_password" type="password"></div><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Create</button></div>`);
    document.getElementById('m_cancel').onclick=closeModal;
    document.getElementById('m_submit').onclick=async()=>{ const r=await fetch('/api/managers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:m_username.value.trim(),email:m_email.value.trim(),password:m_password.value})}); const d=await r.json(); if(!r.ok){modalError.textContent=d.error||'Failed';modalError.classList.add('show');return;} closeModal();render('managers'); };
  };
  content.querySelectorAll('[data-action="edit-manager-balance"]').forEach(btn=>btn.onclick=()=>{
    openModal(`<h3>Edit Manager Balance</h3><div class="auth-error" id="modalError"></div><div class="field"><label>Balance (USD)</label><input class="input" id="m_balance" type="number" min="0" step="0.01" value="${btn.dataset.balance}"></div><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Save</button></div>`);
    document.getElementById('m_cancel').onclick=closeModal; document.getElementById('m_submit').onclick=async()=>{const input=document.getElementById('m_balance'); const err=document.getElementById('modalError'); const value=input.value.trim(); if(value===''){err.textContent='Enter a balance';err.classList.add('show');return;} const r=await fetch(`/api/managers/${btn.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({balance:Number(value)})}); const d=await r.json(); if(!r.ok){err.textContent=d.error||'Failed to save balance';err.classList.add('show');return;} closeModal(); await render('managers');};
  });
  content.querySelectorAll('[data-action="toggle-manager"]').forEach(btn=>btn.onclick=async()=>{await fetch(`/api/managers/${btn.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:btn.dataset.status==='active'?'suspended':'active'})});render('managers');});
}

// ---------- Agents page (Super Admin + Managers) ----------
async function adminsPage() {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  const res = await fetch('/api/admins'); const data = await res.json();
  if(!res.ok){content.innerHTML=`<div class="empty">${data.error||'Could not load agents'}</div>`;return;}
  const rows=data.admins.map(a=>[a.username,a.email,a.managerUsername||'-',String(a.clientCount),`$${Number(a.balance||0).toFixed(2)}`,statusPill(a.status),`${currentUser.role==='super_admin'?`<button class="btn small" data-action="edit-agent-balance" data-id="${a.id}" data-balance="${Number(a.balance||0).toFixed(2)}">Balance</button> `:''}<button class="btn small ${a.status==='active'?'danger':''}" data-action="toggle-agent" data-id="${a.id}" data-status="${a.status}">${a.status==='active'?'Suspend':'Activate'}</button>`]);
  content.innerHTML=`<div class="toolbar"><span class="muted">Agents receive ranges/numbers and manage their Clients. Only Super Admin can edit Agent balances.</span><button class="btn primary" id="addAgentBtn">+ Add Agent</button></div>${table(['Username','Email','Manager','Clients','Balance','Status','Actions'],rows)}`;
  document.getElementById('addAgentBtn').onclick=async()=>{
    let managers=[]; if(currentUser.role==='super_admin'){const mr=await fetch('/api/managers');managers=(await mr.json()).managers||[];}
    const managerField=currentUser.role==='super_admin'?`<div class="field"><label>Manager (optional)</label><select class="input" id="m_manager"><option value="">No manager</option>${managers.filter(m=>m.status==='active').map(m=>`<option value="${m.id}">${m.username}</option>`).join('')}</select></div>`:'';
    openModal(`<h3>Create Agent</h3><div class="auth-error" id="modalError"></div>${managerField}<div class="field"><label>Username</label><input class="input" id="m_username"></div><div class="field"><label>Email (optional)</label><input class="input" id="m_email" type="email"></div><div class="field"><label>Password</label><input class="input" id="m_password" type="password"></div><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Create</button></div>`);
    document.getElementById('m_cancel').onclick=closeModal; document.getElementById('m_submit').onclick=async()=>{const payload={username:m_username.value.trim(),email:m_email.value.trim(),password:m_password.value}; if(currentUser.role==='super_admin'&&document.getElementById('m_manager'))payload.managerId=document.getElementById('m_manager').value; const r=await fetch('/api/admins',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok){modalError.textContent=d.error||'Failed';modalError.classList.add('show');return;}closeModal();render('admins');};
  };
  content.querySelectorAll('[data-action="edit-agent-balance"]').forEach(btn=>btn.onclick=()=>{
    openModal(`<h3>Edit Agent Balance</h3><div class="auth-error" id="modalError"></div><div class="field"><label>Balance (USD)</label><input class="input" id="m_balance" type="number" min="0" step="0.01" value="${btn.dataset.balance}"></div><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Save</button></div>`);
    document.getElementById('m_cancel').onclick=closeModal; document.getElementById('m_submit').onclick=async()=>{const input=document.getElementById('m_balance'); const err=document.getElementById('modalError'); const value=input.value.trim(); if(value===''){err.textContent='Enter a balance';err.classList.add('show');return;} const r=await fetch(`/api/admins/${btn.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({balance:Number(value)})}); const d=await r.json(); if(!r.ok){err.textContent=d.error||'Failed to save balance';err.classList.add('show');return;} closeModal(); await render('admins');};
  });
  content.querySelectorAll('[data-action="toggle-agent"]').forEach(btn=>btn.onclick=async()=>{await fetch(`/api/admins/${btn.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:btn.dataset.status==='active'?'suspended':'active'})});render('admins');});
}

// ---------- Clients page (Admin + Super Admin) ----------
async function clientsPage() {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  const [clientsRes, adminsRes] = await Promise.all([
    fetch('/api/clients'),
    (currentUser.role === 'super_admin' || currentUser.role === 'manager') ? fetch('/api/admins') : Promise.resolve(null),
  ]);
  const clientsData = await clientsRes.json();
  if (!clientsRes.ok) {
    content.innerHTML = `<div class="empty">${clientsData.error || 'Could not load clients'}</div>`;
    return;
  }
  const adminsList = adminsRes ? (await adminsRes.json()).admins : [];

  const showAdminCol = currentUser.role === 'super_admin' || currentUser.role === 'manager';
  const headers = ['Username', 'Email', ...(showAdminCol ? ['Agent'] : []), 'Balance', 'Status', 'Actions'];
  const rows = clientsData.clients.map((c) => [
    c.username,
    c.email,
    ...(showAdminCol ? [c.adminUsername || '-'] : []),
    `$${Number(c.balance).toFixed(2)}`,
    statusPill(c.status),
    `<div class="row-actions">
      ${currentUser.role === 'super_admin' ? `<button class="btn small" data-action="edit-balance" data-id="${c.id}" data-balance="${c.balance}">Balance</button>` : `<span class="muted">Balance view only</span>`}
      <button class="btn small ${c.status === 'active' ? 'danger' : ''}" data-action="toggle-client" data-id="${c.id}" data-status="${c.status}">
        ${c.status === 'active' ? 'Suspend' : 'Activate'}
      </button>
    </div>`,
  ]);

  content.innerHTML = `
    <div class="toolbar">
      <input class="input" placeholder="Search clients..." disabled>
      <button class="btn primary" id="addClientBtn">+ Add Client</button>
    </div>
    ${table(headers, rows)}
  `;

  document.getElementById('addClientBtn').onclick = () => {
    const adminDropdown = showAdminCol
      ? `<div class="field"><label>Assign to Agent</label><select class="input" id="m_admin">
          ${currentUser.role === 'manager' ? '<option value="">My direct Client</option>' : ''}
          ${adminsList
            .filter((a) => a.status === 'active')
            .map((a) => `<option value="${a.id}">${a.username}</option>`)
            .join('')}
        </select><small>${currentUser.role === 'manager' ? 'Leave this as “My direct Client” to keep the client visible only to you. Selecting an Agent makes the client visible only to that Agent.' : 'Choose the Agent who will own this client.'}</small></div>`
      : '';
    openModal(`
      <h3>Create Client</h3>
      <div class="auth-error" id="modalError"></div>
      ${adminDropdown}
      <div class="field"><label>Username</label><input class="input" id="m_username" minlength="3" maxlength="20"></div>
      <div class="field"><label>Email (optional)</label><input class="input" id="m_email" type="email"></div>
      <div class="field"><label>Password</label><input class="input" id="m_password" type="password" minlength="8"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="m_cancel">Cancel</button>
        <button class="btn primary" id="m_submit">Create</button>
      </div>
    `);
    document.getElementById('m_cancel').onclick = closeModal;
    document.getElementById('m_submit').onclick = async () => {
      const payload = {
        username: document.getElementById('m_username').value.trim(),
        email: document.getElementById('m_email').value.trim(),
        password: document.getElementById('m_password').value,
      };
      if (showAdminCol) {
        const selectedAgent = document.getElementById('m_admin').value;
        if (selectedAgent) payload.agentId = selectedAgent;
      }
      const r = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        const err = document.getElementById('modalError');
        err.textContent = d.error || 'Failed';
        err.classList.add('show');
        return;
      }
      closeModal();
      render('clients');
    };
  };

  content.querySelectorAll('[data-action="toggle-client"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const newStatus = btn.dataset.status === 'active' ? 'suspended' : 'active';
      await fetch(`/api/clients/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      render('clients');
    };
  });

  content.querySelectorAll('[data-action="edit-balance"]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      openModal(`
        <h3>Update Balance</h3>
        <div class="auth-error" id="modalError"></div>
        <div class="field"><label>New Balance (USD)</label><input class="input" id="m_balance" type="number" step="0.01" min="0" value="${btn.dataset.balance}"></div>
        <div class="modal-actions">
          <button class="btn ghost" id="m_cancel">Cancel</button>
          <button class="btn primary" id="m_submit">Save</button>
        </div>
      `);
      document.getElementById('m_cancel').onclick = closeModal;
      document.getElementById('m_submit').onclick = async () => {
        const balance = document.getElementById('m_balance').value;
        const r = await fetch(`/api/clients/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ balance }),
        });
        const d = await r.json();
        if (!r.ok) {
          const err = document.getElementById('modalError');
          err.textContent = d.error || 'Failed';
          err.classList.add('show');
          return;
        }
        closeModal();
        render('clients');
      };
    };
  });
}

// ---------- Rate Cards page (real - Phase 3) ----------
async function ratesPage() {
  content.innerHTML = `<div class="empty">Loading SMS rate cards…</div>`;
  if (currentUser.role !== 'super_admin') {
    content.innerHTML = '<div class="empty">You do not have access to Rate Cards.</div>';
    return;
  }
  try {
    const [rangesRes, cardsRes] = await Promise.all([
      fetch('/api/ranges?_=' + Date.now(), {cache:'no-store'}),
      fetch('/api/rate-cards/admin?_=' + Date.now(), {cache:'no-store'})
    ]);
    const rangesData = await rangesRes.json();
    const cardsData = await cardsRes.json();
    if (!rangesRes.ok) throw new Error(rangesData.error || 'Could not load ranges');
    const ranges = rangesData.ranges || [];
    const cards = cardsRes.ok ? (cardsData.rateCards || []) : [];
    const cardMap = new Map(cards.map(c => [`${String(c.country).toLowerCase()}|${String(c.operator).toLowerCase()}`, c]));
    const canEdit = currentUser.role === 'super_admin';

    content.innerHTML = `
      <div class="toolbar" style="gap:10px;flex-wrap:wrap">
        <div><h3 style="margin:0">SMS Rate Cards</h3><div class="muted">Only Super Admin can edit range names and rates.</div></div>
        <button class="btn" id="refreshRateRanges">Refresh</button>
      </div>
      <div class="card" style="margin-bottom:16px">
        <input class="input" id="rateRangeSearch" placeholder="Search range name, country or operator…">
      </div>
      <div id="rateRangeTable"></div>
    `;

    const render = () => {
      const q = String(document.getElementById('rateRangeSearch').value || '').trim().toLowerCase();
      const visible = ranges.filter(r => !q || `${r.name} ${r.country} ${r.operator}`.toLowerCase().includes(q));
      const rows = visible.map(r => {
        const card = cardMap.get(`${String(r.country||'').toLowerCase()}|${String(r.operator||'').toLowerCase()}`);
        const rate = canEdit
          ? Number(r.superAdminRate ?? r.rate ?? 0)
          : Number(card?.clientRate ?? r.clientRate ?? 0);
        const rateCell = canEdit
          ? `<input class="input range-rate-input" data-id="${r.id}" type="number" min="0" step="0.0001" value="${rate.toFixed(4)}" style="width:130px">`
          : `<b>$${rate.toFixed(4)}</b>`;
        const action = canEdit
          ? `<button class="btn small primary" data-save-range-rate="${r.id}">Save</button>`
          : `<span class="badge">View only</span>`;
        return [
          `<input class="input range-name-input" data-id="${r.id}" value="${String(r.name||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}" style="min-width:260px">`,
          r.country || '-',
          r.operator || '-',
          rateCell,
          `${r.availableCount || 0} / ${r.numberCount || 0}`,
          action
        ];
      });
      document.getElementById('rateRangeTable').innerHTML = visible.length
        ? table(['Range','Country','Operator','Rate / SMS','Available / Total','Action'], rows)
        : '<div class="empty">No ranges found.</div>';

      if (!canEdit) return;
      document.querySelectorAll('[data-save-range-rate]').forEach(btn => {
        btn.onclick = async () => {
          const input = document.querySelector(`.range-rate-input[data-id="${btn.dataset.saveRangeRate}"]`);
          const rate = Number(input.value);
          if (!Number.isFinite(rate) || rate < 0) return alert('Enter a valid rate.');
          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            const r = await fetch(`/api/ranges/${btn.dataset.saveRangeRate}`, {
              method: 'PATCH', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({superAdminRate: rate, name: document.querySelector(`.range-name-input[data-id=\"${btn.dataset.saveRangeRate}\"]`).value.trim()})
            });
            const d = await r.json();
            if (!r.ok) return alert(d.error || 'Could not save rate');
            const idx = ranges.findIndex(x => Number(x.id) === Number(btn.dataset.saveRangeRate));
            if (idx >= 0) ranges[idx] = d.range;
            render();
          } finally {
            if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Save'; }
          }
        };
      });
    };
    document.getElementById('rateRangeSearch').oninput = render;
    document.getElementById('refreshRateRanges').onclick = ratesPage;
    render();
  } catch(e) {
    console.error(e); content.innerHTML = `<div class="empty">${e.message || 'Could not load rate cards'}</div>`;
  }
}

async function payoutsPage() {
  if (!['super_admin','manager','agent'].includes(currentUser.role)) {
    content.innerHTML = '<div class="empty">Payouts are available to Managers and Agents only.</div>';
    return;
  }
  content.innerHTML = '<div class="empty">Loading payouts…</div>';
  try {
    const res = await fetch('/api/payouts?_=' + Date.now(), {cache:'no-store'});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load payouts');
    const requests = data.requests || [];
    const paymentProfiles = data.paymentProfiles || [];
    const roleLabel = r => r === 'manager' ? 'Manager' : r === 'agent' ? 'Agent' : r;
    const safe = v => String(v ?? '').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

    if (currentUser.role === 'super_admin') {
      const rows = requests.map(x => [
        new Date(x.createdAt).toLocaleString(),
        `<b>${safe(x.username)}</b>${x.requesterRole==='agent' && x.managerUsername ? ` <span class="muted">(${safe(x.managerUsername)})</span>` : ''}`,
        roleLabel(x.requesterRole),
        `$${Number(x.amount||0).toFixed(2)}`,
        `${new Date(x.periodStart).toLocaleString()} → ${new Date(x.periodEnd).toLocaleString()}`,
        x.paymentMethod === 'binance_email' ? 'Binance Email' : 'USDT Address',
        `<span style="word-break:break-all">${safe(x.paymentInfo)}</span>`,
        statusPill(x.status),
        x.status === 'pending'
          ? `<div class="row-actions"><button class="btn small primary" data-payout-review="${x.id}" data-status="approved">Approve</button><button class="btn small danger" data-payout-review="${x.id}" data-status="rejected">Reject</button></div>`
          : (x.reviewerUsername ? `By ${safe(x.reviewerUsername)}` : '—')
      ]);
      const profileRows = paymentProfiles.map(x => [
        `<b>${safe(x.username)}</b>${x.role==='agent' && x.managerUsername ? ` <span class="muted">(${safe(x.managerUsername)})</span>` : ''}`,
        roleLabel(x.role),
        x.paymentMethod === 'binance_email' ? 'Binance Email' : x.paymentMethod === 'usdt_address' ? 'USDT Address' : 'Not provided',
        x.paymentInfo ? `<span style="word-break:break-all">${safe(x.paymentInfo)}</span>` : '—',
        x.updatedAt ? new Date(x.updatedAt).toLocaleString() : '—'
      ]);
      content.innerHTML = `
        <div class="toolbar"><div><h3 style="margin:0">Payout Requests</h3><div class="muted">Payout requests are available every Wednesday from 5:00 AM to 5:00 PM. The calculation closes at Wednesday 4:59:59 AM.</div></div><button class="btn" id="refreshPayouts">Refresh</button></div>
        <div class="card">${requests.length ? table(['Date','Username','Role','Amount','Period','Method','Payment Info','Status','Action'],rows) : '<div class="empty">No payout requests yet.</div>'}</div>
        <div class="card" style="margin-top:16px"><h3>Manager / Agent Payment Details</h3><div class="muted" style="margin-bottom:12px">Saved payment details remain visible to Super Admin for every Manager and Agent.</div>${profileRows.length ? table(['Username','Role','Payment Method','Payment Info','Last Updated'],profileRows) : '<div class="empty">No Managers or Agents found.</div>'}</div>`;
      document.getElementById('refreshPayouts').onclick=payoutsPage;
      content.querySelectorAll('[data-payout-review]').forEach(btn=>btn.onclick=async()=>{
        const r=await fetch(`/api/payouts/${btn.dataset.payoutReview}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:btn.dataset.status})});
        const d=await r.json(); if(!r.ok)return alert(d.error||'Could not review payout'); await payoutsPage();
      });
      return;
    }

    const period = data.period || {amount:0,periodStart:'',periodEnd:'',isAvailable:false,availableUntil:''};
    const pending = requests.find(x=>x.status==='pending' && x.periodEnd===period.periodEnd);
    const startText = period.periodStart ? new Date(period.periodStart).toLocaleString() : '—';
    const endText = period.periodEnd ? new Date(period.periodEnd).toLocaleString() : '—';
    const untilText = period.availableUntil ? new Date(period.availableUntil).toLocaleString() : '—';
    const availabilityText = period.isAvailable
      ? `Available now until ${untilText}`
      : `Available Wednesday 5:00 AM → 5:00 PM`;
    const canRequest = Boolean(period.isAvailable && Number(period.amount||0) >= 10 && !pending);

    content.innerHTML = `
      <div class="toolbar"><div><h3 style="margin:0">Weekly Payout</h3><div class="muted">Payout window: Wednesday 5:00 AM–5:00 PM. Calculation: from your last approved payout through Wednesday 4:59 AM. If you do not reach $10, the amount carries forward to the next Wednesday.</div></div><button class="btn" id="refreshPayouts">Refresh</button></div>
      <div class="grid" style="margin-bottom:16px">
        <div class="card"><div class="label">Available Balance</div><div class="value">$${Number(currentUser.balance||0).toFixed(2)}</div><div class="up">Your current balance</div></div>
        <div class="card"><div class="label">Available Payout</div><div class="value">$${Number(period.amount||0).toFixed(3)}</div><div class="up">${availabilityText}</div></div>
        <div class="card"><div class="label">Minimum Request</div><div class="value">$10.00</div><div class="up">${Number(period.amount||0) < 10 ? 'Carries forward if below minimum' : 'Minimum payout'}</div></div>
      </div>
      <div class="card">
        <h3>Current Calculation Period</h3>
        <p class="muted">${startText} → ${endText} (earnings are counted up to 4:59 AM Wednesday)</p>
        <h3>Request Payout</h3>
        ${pending ? `<div class="notice">A pending request of <b>$${Number(pending.amount).toFixed(2)}</b> already exists for this payout period.</div>` :
          !period.isAvailable ? `<div class="notice">Payout requests open every Wednesday at 5:00 AM and close at 5:00 PM.</div>` :
          Number(period.amount||0) < 10 ? `<div class="notice">Your available payout is below the $10 minimum. It will carry forward and can be requested on a future Wednesday once the minimum is reached.</div>` : `
          <div class="grid">
            <div class="field"><label>Amount (USD)</label><input class="input" id="payoutAmount" type="number" min="10" step="0.01" max="${Number(period.amount||0).toFixed(2)}" value="${Number(period.amount||0).toFixed(2)}"></div>
            <div class="field"><label>Payment Method</label><select class="input" id="payoutMethod"><option value="binance_email">Binance Email</option><option value="usdt_address">USDT Address</option></select></div>
          </div>
          <div class="field"><label>Binance Email / USDT Address</label><input class="input" id="payoutInfo" placeholder="Enter your payment information"></div>
          <button class="btn primary" id="requestPayout" ${canRequest?'':'disabled'}>Request Payout</button>
          <div class="muted" id="payoutError" style="margin-top:10px"></div>`}
      </div>
      <div class="card" style="margin-top:16px"><h3>My Requests</h3>${requests.length ? table(['Date','Amount','Period','Method','Payment Info','Status'],requests.map(x=>[new Date(x.createdAt).toLocaleString(),`$${Number(x.amount).toFixed(2)}`,new Date(x.periodStart).toLocaleDateString()+' → '+new Date(x.periodEnd).toLocaleDateString(),x.paymentMethod==='binance_email'?'Binance Email':'USDT Address',safe(x.paymentInfo),statusPill(x.status)])) : '<div class="empty">No payout requests yet.</div>'}</div>
    `;
    document.getElementById('refreshPayouts').onclick=payoutsPage;
    if (canRequest && document.getElementById('requestPayout')) document.getElementById('requestPayout').onclick=async()=>{
      const btn=document.getElementById('requestPayout'); btn.disabled=true; btn.textContent='Submitting…';
      const r=await fetch('/api/payouts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:document.getElementById('payoutAmount').value,paymentMethod:document.getElementById('payoutMethod').value,paymentInfo:document.getElementById('payoutInfo').value})});
      const d=await r.json();
      if(!r.ok){const e=document.getElementById('payoutError');if(e)e.textContent=d.error||'Could not submit payout';btn.disabled=false;btn.textContent='Request Payout';return;}
      alert('Payout request sent to Super Admin.'); await payoutsPage();
    };
  } catch(e) {
    console.error(e); content.innerHTML=`<div class="empty">${e.message||'Could not load payouts'}</div>`;
  }
}

async function submitBaseRate(country, operator, baseRate) {
  const r = await fetch('/api/rate-cards/base', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country, operator, baseRate }),
  });
  const d = await r.json();
  if (!r.ok) {
    const err = document.getElementById('modalError');
    if (err) { err.textContent = d.error || 'Failed'; err.classList.add('show'); }
    return;
  }
  closeModal();
  render('rates');
}

async function submitAdminRate(country, operator, clientRate) {
  const r = await fetch('/api/rate-cards/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country, operator, clientRate }),
  });
  const d = await r.json();
  if (!r.ok) {
    const err = document.getElementById('modalError');
    if (err) { err.textContent = d.error || 'Failed'; err.classList.add('show'); }
    return;
  }
  closeModal();
  render('rates');
}

// ---------- Range / Number inventory ----------
async function loadClientNumbersPage() {
  content.innerHTML = `<div class="empty">Loading numbers...</div>`;
  try {
    const res = await fetch('/api/numbers?page=1&limit=25');
    const data = await res.json();
    if (!res.ok) {
      content.innerHTML = `<div class="empty">${data.error || 'Could not load numbers'}</div>`;
      return;
    }
    renderClientNumbers(data);
  } catch (e) {
    console.error(e);
    content.innerHTML = `<div class="empty">Could not load numbers. Please refresh and try again.</div>`;
  }
}

function renderClientNumbers(data, userRanges = null) {
  const numbers = data.numbers || [];
  const total = Number(data.total || 0);
  const limit = Number(data.limit || 25);
  const page = Number(data.page || 1);
  const pages = Math.max(1, Math.ceil(total / limit));

  // Build the range list from the numbers returned for this client. This means
  // the page works even if a reseller range is not explicitly assigned to the
  // client; the original number -> carrierRange relationship is enough.
  const rangeMap = new Map();
  numbers.forEach(n => {
    const key = n.rangeId != null ? String(n.rangeId) : `direct-${n.id}`;
    if (!rangeMap.has(key)) rangeMap.set(key, n.rangeName || 'Direct allocation');
  });

  const selectedRange = window.clientSelectedRange || '';
  const availableRanges = Array.isArray(userRanges) && userRanges.length ? userRanges : [...rangeMap.entries()].map(([id,name])=>({id,name}));
  const filtered = selectedRange
    ? numbers.filter(n => String(n.rangeId ?? `direct-${n.id}`) === selectedRange)
    : numbers;

  const rows = filtered.map(n => {
    const split = splitCountryCode(n.msisdn);
    const numberCell = separateCountryCode
      ? `${split.cc ? `<span class="badge">${split.cc}</span>` : '<span class="muted">CC?</span>'} <span>${split.number}</span> <button class="btn small ghost copy-btn" data-copy="${split.number}">⧉</button>`
      : `<span>${n.msisdn}</span> <button class="btn small ghost copy-btn" data-copy="${n.msisdn}">⧉</button>`;
    const rate = n.clientRate != null ? Number(n.clientRate) : 0;
    return [
      n.rangeName || 'Direct allocation',
      numberCell,
      `$${rate.toFixed(4)}`,
      statusPill(n.status)
    ];
  });

  content.innerHTML = `
    <div class="toolbar" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div><b>My Numbers</b><div class="muted">Numbers assigned to you by your Agent/Manager.</div></div>
      <button class="btn ghost" id="clientRefresh">Refresh</button>
    </div>
    <div class="card my-numbers-filter-card" style="margin-bottom:16px;overflow:visible;position:relative;z-index:50">
      <div class="toolbar" style="margin:0;gap:10px;flex-wrap:wrap;justify-content:flex-start">
        <input class="input" id="clientRangeSearch" placeholder="Search your ranges…" style="min-width:220px"><select class="input" id="clientRangeFilter" style="min-width:220px">
          <option value="">All ranges</option>
          ${availableRanges.map(r=>`<option value="${r.id}" ${String(selectedRange)===String(r.id)?'selected':''}>${r.name}</option>`).join('')}
        </select>
        <button class="btn primary" id="clientSeparateCC">${separateCountryCode ? 'Show Full Number' : 'Separate CC'}</button>
      </div>
    </div>
    <div class="card">
      ${rows.length ? table(['Range','Number','Your Rate','Status'], rows) : '<div class="empty">No numbers have been assigned to you yet.</div>'}
      <div class="toolbar" style="justify-content:center;margin:14px 0 0">
        <button class="btn" id="clientPrev" ${page<=1?'disabled':''}>‹ Previous</button>
        <span class="muted">Page ${page} / ${pages} · ${total} total</span>
        <button class="btn" id="clientNext" ${page>=pages?'disabled':''}>Next ›</button>
      </div>
    </div>`;

  document.getElementById('clientRefresh').onclick = () => loadClientNumbersPagePage(page);
  document.getElementById('clientSeparateCC').onclick = () => { separateCountryCode = !separateCountryCode; renderClientNumbers(data); };
  document.getElementById('clientRangeSearch').oninput = e => { const q=e.target.value.trim().toLowerCase(); const sel=document.getElementById('clientRangeFilter'); sel.innerHTML='<option value="">All ranges</option>'+availableRanges.filter(r=>!q||String(r.name).toLowerCase().startsWith(q)).map(r=>`<option value="${r.id}">${r.name}</option>`).join(''); if(window.clientSelectedRange && [...sel.options].some(o=>o.value===window.clientSelectedRange)) sel.value=window.clientSelectedRange; else { window.clientSelectedRange=''; renderClientNumbers(data, availableRanges); } };
  document.getElementById('clientRangeFilter').onchange = e => { window.clientSelectedRange = e.target.value; renderClientNumbers(data); };
  document.getElementById('clientPrev').onclick = () => loadClientNumbersPagePage(page - 1);
  document.getElementById('clientNext').onclick = () => loadClientNumbersPagePage(page + 1);
  content.querySelectorAll('.copy-btn').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const old=b.textContent; b.textContent='✓'; setTimeout(()=>b.textContent=old,900); } catch(e) {}
  });
}

async function loadClientNumbersPagePage(page) {
  content.innerHTML = `<div class="empty">Loading numbers...</div>`;
  try {
    const [res, rangesRes] = await Promise.all([fetch(`/api/numbers?page=${Math.max(1,page)}&limit=25`), fetch('/api/numbers/ranges?_=' + Date.now(), {cache:'no-store'})]);
    const data = await res.json(); const rangesData = await rangesRes.json();
    if (!res.ok) throw new Error(data.error || 'Could not load numbers');
    renderClientNumbers(data, rangesData.ranges || []);
  } catch (e) {
    console.error(e);
    content.innerHTML = `<div class="empty">${e.message || 'Could not load numbers'}</div>`;
  }
}

async function rangesCatalogPage() {
  content.innerHTML = `<div class="empty">Loading SMS ranges...</div>`;
  try {
    const [rangesRes, requestsRes] = await Promise.all([
      fetch('/api/ranges?_=' + Date.now(), { cache:'no-store' }),
      fetch('/api/range-requests?_=' + Date.now(), { cache:'no-store' })
    ]);
    const rangesData = await rangesRes.json();
    const requestsData = await requestsRes.json();
    if (!rangesRes.ok) throw new Error(rangesData.error || 'Could not load ranges');
    const ranges = rangesData.ranges || [];
    const requests = requestsRes.ok ? (requestsData.requests || []) : [];
    const requestMap = new Map(requests.filter(x=>x.status==='pending').map(x=>[Number(x.rangeId),x]));
    let page = 1;
    const pageSize = 25;
    let rateSort = 0; // 0 none, 1 ascending, -1 descending; range catalog only

    function esc(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function render() {
      const q = String(document.getElementById('rangeCatalogSearch')?.value || '').trim().toLowerCase();
      let filtered = ranges.filter(r => !q || [r.name,r.country,r.operator,r.prefix,r.testNumber].some(v=>String(v||'').toLowerCase().includes(q)));
      if(rateSort) filtered = [...filtered].sort((a,b)=>rateSort*(Number(a.superAdminRate??a.rate??0)-Number(b.superAdminRate??b.rate??0)));
      const pages = Math.max(1, Math.ceil(filtered.length/pageSize));
      page = Math.min(page,pages);
      const slice = filtered.slice((page-1)*pageSize,page*pageSize);
      const rows = slice.map(r => {
        const pending = requestMap.get(Number(r.id));
        let action = currentUser.role==='super_admin'
          ? `<div class="row-actions"><button class="btn small" data-range-edit="${r.id}">Edit</button><button class="btn small primary" data-range-assign="${r.id}">Assign</button></div>`
          : pending
            ? `<button class="btn small" disabled>Requested</button>`
            : `<button class="btn small primary" data-range-request="${r.id}">Request</button>`;
        const rate = currentUser.role==='super_admin' ? Number(r.superAdminRate ?? r.rate ?? 0) : Number(r.clientRate ?? r.effectiveRate ?? r.superAdminRate ?? 0);
        const memo = r.memo || (r.operator ? `${esc(r.operator)} range` : '—');
        return [
          `<b>${esc(r.name)}</b>`,
          esc(r.prefix || '—'),
          esc(r.testNumber || '—'),
          `$${rate.toFixed(4)}`,
          esc(r.limit || '—'),
          `<span class="badge">${Number(r.heldCount||0)}</span> <span class="muted">/ ${Number(r.roomCount||1000)}</span>`,
          action
        ];
      });
      const requestPanel = requests.length && currentUser.role !== 'client' ? `
        <div class="card range-request-panel" style="margin-top:16px">
          <div class="toolbar" style="margin:0 0 8px"><div><b>Range Requests</b><div class="muted">Requests from users in your hierarchy.</div></div><button class="btn small" id="refreshRangeRequests">Refresh</button></div>
          ${table(['Date','User','Range','Role','Status','Action'], requests.slice(0,25).map(x=>[
            new Date(x.createdAt).toLocaleString(), esc(x.requesterUsername), esc(x.rangeName), roleBadge(x.requesterRole), statusPill(x.status),
            x.status==='pending' ? `<div class="row-actions"><button class="btn small primary" data-request-review="${x.id}" data-status="approved">Approve</button><button class="btn small danger" data-request-review="${x.id}" data-status="rejected">Reject</button></div>` : (x.reviewerUsername ? `By ${esc(x.reviewerUsername)}` : '—')
          ]))}
        </div>` : '';
      content.innerHTML = `
        <div class="toolbar" style="align-items:center;gap:12px;flex-wrap:wrap">
          <div><b>SMS Ranges</b><div class="muted">All available carrier ranges. ${currentUser.role==='super_admin'?'Manage and allocate ranges.':'Request a range you need.'}</div></div>
          <button class="btn primary" id="refreshRangeCatalog">Refresh</button>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div class="toolbar" style="margin:0;gap:10px;justify-content:space-between;flex-wrap:wrap">
            <input class="input" id="rangeCatalogSearch" value="${esc(q)}" placeholder="Search range name or prefix…" style="min-width:260px;flex:1"><button class="btn" id="rateSortBtn">Rate ↕</button>
            <span class="muted">Showing ${filtered.length ? (page-1)*pageSize+1 : 0}–${Math.min(page*pageSize,filtered.length)} of ${filtered.length} ranges</span>
          </div>
        </div>
        <div class="card range-catalog-card">
          ${slice.length ? table(['Name','Prefix','Test number','Rate / SMS','Limit','Held / Room','Action'],rows) : '<div class="empty">No ranges found.</div>'}
          <div class="toolbar" style="justify-content:center;margin:14px 0 0">
            <button class="btn" id="rangePrev" ${page<=1?'disabled':''}>‹ Previous</button>
            <span class="muted">Page ${page} / ${pages}</span>
            <button class="btn" id="rangeNext" ${page>=pages?'disabled':''}>Next ›</button>
          </div>
        </div>
        ${requestPanel}`;

      document.getElementById('rangeCatalogSearch').oninput = () => { page=1; render(); };
      document.getElementById('rateSortBtn').onclick = () => { rateSort = rateSort === 0 ? 1 : rateSort === 1 ? -1 : 0; document.getElementById('rateSortBtn').textContent = rateSort === 1 ? 'Rate ↑' : rateSort === -1 ? 'Rate ↓' : 'Rate ↕'; page=1; render(); };
      document.getElementById('rangePrev').onclick = () => { page--; render(); };
      document.getElementById('rangeNext').onclick = () => { page++; render(); };
      document.getElementById('refreshRangeCatalog').onclick = rangesCatalogPage;
      document.getElementById('refreshRangeRequests')?.addEventListener('click', rangesCatalogPage);
      content.querySelectorAll('[data-range-request]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true; btn.textContent='Requesting…';
        const rr = await fetch('/api/range-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rangeId:Number(btn.dataset.rangeRequest)})});
        const d = await rr.json();
        if(!rr.ok) { alert(d.error||'Could not send request'); btn.disabled=false; btn.textContent='Request'; return; }
        alert('Range request sent successfully.'); await rangesCatalogPage();
      });
      content.querySelectorAll('[data-request-review]').forEach(btn => btn.onclick = async () => {
        const rr = await fetch(`/api/range-requests/${btn.dataset.requestReview}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:btn.dataset.status})});
        const d = await rr.json(); if(!rr.ok){alert(d.error||'Could not review request');return;} await rangesCatalogPage();
      });
      content.querySelectorAll('[data-range-edit]').forEach(btn => btn.onclick = () => {
        const r = ranges.find(x=>Number(x.id)===Number(btn.dataset.rangeEdit)); if(r) openEditRange(r.id,r);
      });
      content.querySelectorAll('[data-range-assign]').forEach(btn => btn.onclick = () => assignRangeModal(btn.dataset.rangeAssign));
    }
    render();
  } catch(e) {
    console.error(e); content.innerHTML = `<div class="empty">${e.message || 'Could not load ranges'}</div>`;
  }
}

async function numbersPage() {
  // Number inventory is separate from the carrier-style range catalogue.
  if (currentUser.role === 'client') return loadClientNumbersPage();
  content.innerHTML = `<div class="empty">Loading numbers...</div>`;
  const userRangesRes = await fetch('/api/numbers/ranges?_=' + Date.now(), {cache:'no-store'});
  const userRangesData = await userRangesRes.json();
  if (!userRangesRes.ok) { content.innerHTML = `<div class="empty">${userRangesData.error || 'Could not load your ranges'}</div>`; return; }
  const ranges = userRangesData.ranges || [];
  let numberPageSize = 25;
  let clients=[]; let agents=[]; let managers=[];
  if (['super_admin','manager','agent'].includes(currentUser.role)) clients=(await (await fetch('/api/clients')).json()).clients||[];
  if (currentUser.role === 'super_admin' || currentUser.role === 'manager') agents=(await (await fetch('/api/admins')).json()).admins||[];
  if (currentUser.role === 'super_admin') managers=(await (await fetch('/api/managers')).json()).managers||[];

  content.innerHTML = `
    <div class="toolbar" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div><b>My Numbers</b><div class="muted">Manage your allocated number inventory.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="refreshRangesBtn">Refresh</button><select class="input" id="numberPageSize" style="width:120px"><option value="25">25 / page</option><option value="50">50 / page</option><option value="100">100 / page</option><option value="250">250 / page</option></select></div>
    </div>
    <div class="card my-numbers-filter-card" style="margin-bottom:16px;overflow:visible;position:relative;z-index:50">
      <div class="toolbar" style="margin:0;gap:10px;flex-wrap:wrap;justify-content:flex-start;align-items:flex-end">
        <div class="my-numbers-range-field" style="min-width:300px;flex:1;position:relative;z-index:100">
          <label class="muted" style="display:block;margin-bottom:6px">Select Range</label>
          <button class="input range-picker-display" id="rangePickerBtn" type="button" aria-haspopup="listbox" aria-expanded="false" style="width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between;background:#fff;cursor:pointer"><span id="rangePickerLabel">All ranges</span><span aria-hidden="true">⌄</span></button>
          <div id="rangePickerMenu" style="display:none;position:absolute;z-index:30;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #cfd7e6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:8px">
            <input class="input" id="rangePickerSearch" placeholder="Search range name…" autocomplete="off" style="width:100%;margin-bottom:6px">
            <div id="rangePickerOptions" style="max-height:300px;overflow:auto"></div>
          </div>
          <input type="hidden" id="rangeFilter" value="">
        </div>
        <select class="input" id="allocationFilter" style="min-width:150px"><option value="">All clients</option><option value="available">Available</option><option value="assigned">Assigned</option><option value="paused">Paused</option></select>
        <input class="input" id="prefixFilter" placeholder="Number starts with…" style="min-width:180px">
        <input class="input" id="rangeContainsFilter" placeholder="Range contains…" style="min-width:180px">
        <button class="btn primary" id="filterBtn">Filter</button><button class="btn ghost" id="resetFilterBtn">Reset</button>
      </div>
    </div>
    <div id="inventoryArea"><div class="empty">Select a range or click Filter.</div></div>`;
  document.getElementById('refreshRangesBtn').onclick=()=>numbersPage();

  const rangeFilter = document.getElementById('rangeFilter');
  const rangePickerBtn = document.getElementById('rangePickerBtn');
  const rangePickerMenu = document.getElementById('rangePickerMenu');
  const rangePickerSearch = document.getElementById('rangePickerSearch');
  const rangePickerOptions = document.getElementById('rangePickerOptions');
  const rangePickerLabel = document.getElementById('rangePickerLabel');
  const renderRangeOptions = (query='') => {
    const q=String(query||'').trim().toLowerCase();
    const list=ranges.filter(r=>!q||String(r.name||'').toLowerCase().includes(q));
    rangePickerOptions.innerHTML = [
      `<button type="button" class="range-picker-option" data-value="" style="display:flex;width:100%;text-align:left;border:0;background:transparent;padding:10px 8px;cursor:pointer;font-weight:600;justify-content:space-between;gap:10px"><span>All ranges</span></button>`,
      ...list.map(r=>`<button type="button" class="range-picker-option" data-value="${escapeHtml(String(r.id))}" data-external-id="${escapeHtml(String(r.externalId || r.id))}" style="display:flex;width:100%;text-align:left;border:0;background:transparent;padding:10px 8px;cursor:pointer;justify-content:space-between;gap:10px;pointer-events:auto"><span>${escapeHtml(r.name)}</span><span class="muted">${Number(r.count||0)}</span></button>`)
    ].join('');
  };
  renderRangeOptions();

  // Use event delegation + mousedown so selecting an option is reliable even if
  // the dropdown is inside a toolbar/card with other click handlers.
  rangePickerOptions.addEventListener('mousedown', e => {
    const btn = e.target.closest('.range-picker-option');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const value = btn.dataset.value || '';
    const rr = value ? ranges.find(r => String(r.id) === String(value)) : null;
    rangeFilter.value = value;
    rangePickerLabel.textContent = rr ? rr.name : 'All ranges';
    rangePickerLabel.title = rr ? rr.name : 'All ranges';
    rangePickerBtn.dataset.selectedRange = value;
    rangePickerBtn.setAttribute('aria-expanded', 'false');
    rangePickerMenu.style.display = 'none';
    rangePickerSearch.value = '';
    renderRangeOptions('');
  });
  rangePickerOptions.addEventListener('click', e => e.stopPropagation());
  rangePickerSearch.addEventListener('mousedown', e => e.stopPropagation());
  rangePickerSearch.addEventListener('click', e => e.stopPropagation());
  rangePickerBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const opening = rangePickerMenu.style.display === 'none' || !rangePickerMenu.style.display;
    rangePickerMenu.style.display = opening ? 'block' : 'none';
    rangePickerBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if(opening){ rangePickerSearch.focus(); renderRangeOptions(rangePickerSearch.value); }
  });
  rangePickerSearch.addEventListener('input', () => renderRangeOptions(rangePickerSearch.value));
  document.addEventListener('click', e => {
    if(!rangePickerMenu.contains(e.target) && !rangePickerBtn.contains(e.target)) {
      rangePickerMenu.style.display='none';
      rangePickerBtn.setAttribute('aria-expanded', 'false');
    }
  });
  document.getElementById('filterBtn').onclick=()=>loadInventoryPage(1);
  document.getElementById('resetFilterBtn').onclick=()=>{rangeFilter.value='';rangePickerLabel.textContent='All ranges';rangePickerLabel.title='All ranges';rangePickerBtn.dataset.selectedRange='';rangePickerBtn.setAttribute('aria-expanded','false');rangePickerMenu.style.display='none';rangePickerSearch.value='';renderRangeOptions();document.getElementById('allocationFilter').value='';document.getElementById('prefixFilter').value='';document.getElementById('rangeContainsFilter').value='';loadInventoryPage(1);};
  document.getElementById('numberPageSize').onchange=()=>{numberPageSize=Number(document.getElementById('numberPageSize').value)||25;loadInventoryPage(1);};
  await loadInventoryPage(1);

  async function loadInventoryPage(page) {
    const area=document.getElementById('inventoryArea');
    const rangeId=document.getElementById('rangeFilter').value;
    const status=document.getElementById('allocationFilter').value;
    const prefix=document.getElementById('prefixFilter').value.trim();
    const rangeText=document.getElementById('rangeContainsFilter').value.trim().toLowerCase();
    let visibleRanges=ranges;
    if(rangeId) visibleRanges=ranges.filter(r=>String(r.id)===String(rangeId));
    if(rangeText) visibleRanges=visibleRanges.filter(r=>String(r.name).toLowerCase().includes(rangeText));
    const selectedRange=rangeId ? visibleRanges[0] : null;
    if(rangeId && !selectedRange){area.innerHTML='<div class="empty">No matching range.</div>';return;}
    const params=new URLSearchParams({page:String(page),limit:String(numberPageSize)});
    if(selectedRange) params.set('rangeId', String(selectedRange.externalId));
    if(status && ['available','assigned','paused'].includes(status)) params.set('status',status);
    if(prefix) params.set('search',prefix);
    area.innerHTML=`<div class="empty">Loading ${numberPageSize} numbers…</div>`;
    const nr=await fetch('/api/numbers?'+params.toString()); const nd=await nr.json();
    if(!nr.ok){area.innerHTML=`<div class="empty">${nd.error||'Could not load numbers'}</div>`;return;}
    const nums=nd.numbers||[]; const total=Number(nd.total||0); const pages=Math.max(1,Math.ceil(total/numberPageSize));
    const selectedRangeId=selectedRange?.id || null;
    const rangeHeader=selectedRange
      ? `<div class="toolbar" style="margin:0 0 12px;align-items:center"><div><h3 style="margin:0">${selectedRange.name}</h3><div class="muted">${selectedRange.country} · ${selectedRange.operator} · ${total} numbers · ${selectedRange.availableCount} available</div><div class="muted">Rate: <b>$${Number(selectedRange.effectiveRate||0).toFixed(4)}</b> / SMS · Manager: ${selectedRange.managerUsername||'Unassigned'} · Agent: ${selectedRange.agentUsername||'Unassigned'}</div></div><div class="row-actions">${currentUser.role==='super_admin'?`<button class="btn small ghost" data-action="edit-range" data-id="${selectedRangeId}">Edit rate</button><button class="btn small" data-action="assign-range" data-id="${selectedRangeId}">Assign Range</button>`:''}</div></div>`
      : `<div class="toolbar" style="margin:0 0 12px;align-items:center"><div><h3 style="margin:0">All My Numbers</h3><div class="muted">${total} numbers visible in your account.</div></div></div>`;
    const rows=nums.map(n=>{
      const split=splitCountryCode(n.msisdn); const prefixValue=String(n.msisdn||'').replace(/^\+/, '').slice(0,3); const rowRange=ranges.find(r=>Number(r.id)===Number(n.rangeId)); const payout=n.superAdminRate ?? rowRange?.superAdminRate ?? rowRange?.rate ?? 0; const holderText=n.assignedClientUsername || (n.holderUsername ? `${n.holderUsername} (${n.holderRole==='agent'?'Agent':n.holderRole==='manager'?'Manager':'Client'})` : '-'); const canAllocateHeld=n.status==='available' && (!n.holderUserId || Number(n.holderUserId)===Number(currentUser.id)); const actionButtons=n.status==='assigned'?`<button class="btn small danger" data-action="unassign-number" data-id="${n.id}">Unassign</button>`:n.status==='paused'?`<button class="btn small" data-action="activate-number" data-id="${n.id}">Activate</button>`:(canAllocateHeld?`<button class="btn small" data-action="assign-number" data-id="${n.id}">Allocate</button> <button class="btn small ghost" data-action="pause-number" data-id="${n.id}">Pause</button>`:'<span class="muted">In use</span>'); const numberCell=separateCountryCode?`${split.cc ? `<span class="badge">${split.cc}</span>` : '<span class="muted">CC?</span>'} <span>${split.number}</span> <button class="btn small ghost copy-btn" data-copy="${split.number}">⧉</button>`:`<span>${n.msisdn}</span> <button class="btn small ghost copy-btn" data-copy="${n.msisdn}">⧉</button>`; return [`<input type="checkbox" class="number-check" value="${n.id}">`,n.rangeName||rowRange?.name||'Direct allocation',prefixValue,numberCell,`$${Number(payout).toFixed(4)}`,holderText,`$${Number(n.clientRate??0).toFixed(4)}`,`7/1`,`SD : 30 | SW : 0`,statusPill(n.status),`<div class="row-actions">${actionButtons}</div>`];
    });
    area.innerHTML=`<div class="card">${rangeHeader}<div class="toolbar" style="justify-content:flex-start;align-items:center;margin:10px 0"><button class="btn primary" id="bulkAssignBtn">Assign</button><button class="btn" id="bulkUnassignBtn">Unassign</button><button class="btn ghost" id="bulkReturnBtn">Return</button><button class="btn ghost" id="separateCCBtn">${separateCountryCode?'Show Full Number':'Separate CC'}</button><span class="muted" id="selectedCount">0 selected</span><span style="margin-left:auto" class="muted">Page ${page} of ${pages} · ${total} total</span></div>${nums.length?table(['<input type="checkbox" id="selectAllNumbers" title="Select all on this page">','Range','Prefix','Number','My Payout','Client','Client Rate','Plan','Limits','Status','Actions'],rows):'<div class="empty">No numbers in this range match the filters.</div>'}<div class="toolbar" style="justify-content:center;margin:14px 0 0"><button class="btn" id="prevPage" ${page<=1?'disabled':''}>‹ Previous</button><span class="muted">Page ${page} / ${pages}</span><button class="btn" id="nextPage" ${page>=pages?'disabled':''}>Next ›</button></div></div>`;
    document.getElementById('separateCCBtn').onclick=()=>{separateCountryCode=!separateCountryCode;loadInventoryPage(page);}; const checks=[...area.querySelectorAll('.number-check')]; const selected=()=>checks.filter(c=>c.checked).map(c=>Number(c.value)); const selectAll=document.getElementById('selectAllNumbers'); if(selectAll) selectAll.onchange=()=>{checks.forEach(c=>c.checked=selectAll.checked);updateSelected();}; const updateSelected=()=>document.getElementById('selectedCount').textContent=`${selected().length} selected`; checks.forEach(c=>c.onchange=updateSelected); area.querySelectorAll('.copy-btn').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);const old=b.textContent;b.textContent='✓';setTimeout(()=>b.textContent=old,900);}catch(e){}}); document.getElementById('prevPage').onclick=()=>loadInventoryPage(page-1);document.getElementById('nextPage').onclick=()=>loadInventoryPage(page+1);document.getElementById('bulkAssignBtn').onclick=()=>bulkAssign(selected());document.getElementById('bulkUnassignBtn').onclick=()=>bulkAction('unassign',selected());document.getElementById('bulkReturnBtn').onclick=()=>bulkAction('return',selected()); area.querySelectorAll('[data-action="assign-number"]').forEach(btn=>btn.onclick=()=>assignOne(btn.dataset.id));area.querySelectorAll('[data-action="unassign-number"]').forEach(btn=>btn.onclick=async()=>{await fetch(`/api/numbers/${btn.dataset.id}/release`,{method:'POST'});loadInventoryPage(page);});area.querySelectorAll('[data-action="pause-number"]').forEach(btn=>btn.onclick=async()=>{await fetch(`/api/numbers/${btn.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'paused'})});loadInventoryPage(page);});area.querySelectorAll('[data-action="activate-number"]').forEach(btn=>btn.onclick=async()=>{await fetch(`/api/numbers/${btn.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'available'})});loadInventoryPage(page);});area.querySelectorAll('[data-action="edit-range"]').forEach(btn=>btn.onclick=()=>openEditRange(btn.dataset.id,selectedRange));area.querySelectorAll('[data-action="assign-range"]').forEach(btn=>btn.onclick=()=>assignRangeModal(btn.dataset.id));
  }
  function assignOne(id){ const targetPool=currentUser.role==='super_admin'?[...managers.map(x=>({...x,role:'manager'})),...agents.map(x=>({...x,role:'agent'})),...clients.map(x=>({...x,role:'client'}))]:currentUser.role==='manager'?[...agents.filter(a=>a.status==='active').map(x=>({...x,role:'agent'})),...clients.filter(c=>c.status==='active').map(x=>({...x,role:'client'}))]:clients.filter(c=>c.status==='active').map(x=>({...x,role:'client'})); if(!targetPool.length){alert('No active recipient is available in your scope.');return;} const groups=['manager','agent','client'].map(role=>{const xs=targetPool.filter(x=>x.role===role);return xs.length?`<optgroup label="${role[0].toUpperCase()+role.slice(1)}">${xs.map(x=>`<option value="${x.id}">${x.username}</option>`).join('')}</optgroup>`:''}).join(''); openModal(`<h3>Allocate Number</h3><div class="field"><label>Recipient</label><select class="input" id="m_target">${groups}</select></div><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Allocate</button></div>`);document.getElementById('m_cancel').onclick=closeModal;document.getElementById('m_submit').onclick=async()=>{const r=await fetch(`/api/numbers/${id}/allocate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetUserId:document.getElementById('m_target').value})});const d=await r.json();if(!r.ok){alert(d.error||'Failed');return;}closeModal();loadInventoryPage(1);}; }
  function bulkAssign(ids){
  if(!ids.length){alert('Select at least one number.');return;}
  const targetPool=currentUser.role==='super_admin'
    ? [...managers.map(x=>({...x,role:'manager'})),...agents.filter(x=>x.status==='active').map(x=>({...x,role:'agent'})),...clients.filter(x=>x.status==='active').map(x=>({...x,role:'client'}))]
    : currentUser.role==='manager'
      ? [...agents.filter(x=>x.status==='active').map(x=>({...x,role:'agent'})),...clients.filter(x=>x.status==='active').map(x=>({...x,role:'client'}))]
      : clients.filter(x=>x.status==='active').map(x=>({...x,role:'client'}));
  if(!targetPool.length){alert('No eligible recipient is available in your scope.');return;}
  const groups=['manager','agent','client'].map(role=>{const xs=targetPool.filter(x=>x.role===role);return xs.length?`<optgroup label="${role[0].toUpperCase()+role.slice(1)}">${xs.map(x=>`<option value="${x.id}">${x.username}</option>`).join('')}</optgroup>`:''}).join('');
  openModal(`<h3>Allocate Selected Numbers</h3><div class="field"><label>Recipient</label><select class="input" id="m_target">${groups}</select></div><p class="muted">${ids.length} selected</p><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Allocate</button></div>`);
  document.getElementById('m_cancel').onclick=closeModal;
  document.getElementById('m_submit').onclick=async()=>{
    let failed=0;
    for(const id of ids){
      const r=await fetch(`/api/numbers/${id}/allocate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetUserId:document.getElementById('m_target').value})});
      if(!r.ok) failed++;
    }
    closeModal(); if(failed) alert(`${failed} number(s) could not be allocated.`); loadInventoryPage(1);
  };
}
function bulkAction(action,ids){if(!ids.length){alert('Select at least one number.');return;}fetch('/api/numbers/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,numberIds:ids})}).then(r=>r.json().then(d=>({r,d}))).then(({r,d})=>{if(!r.ok)alert(d.error||'Failed');else loadInventoryPage(1);});}
  function canManageRange(r){return currentUser.role==='super_admin'||(currentUser.role==='manager'&& (r.assignedManagerId===currentUser.id || (r.assignedAgentId&&agents.some(a=>a.id===r.assignedAgentId))))||(currentUser.role==='agent'&&r.assignedAgentId===currentUser.id);}
  function openEditRange(id,r){
  if(currentUser.role!=='super_admin'){alert('Only Super Admin can edit range details.');return;}
  const safe=v=>String(v??'').replace(/"/g,'&quot;');
  openModal(`<h3>Edit Range</h3>
    <div class="field"><label>Range name</label><input class="input" id="m_name" value="${safe(r.name)}"></div>
    <div class="field"><label>Rate per SMS ($)</label><input class="input" id="m_rate" type="number" min="0" step="0.0001" value="${Number(r.superAdminRate??r.rate??0).toFixed(4)}"></div>
    <div class="field"><label>Limit</label><input class="input" id="m_limit" value="${safe(r.limit||'')}"></div>
    <div class="muted">Held is fixed at 1000 for every range.</div>
    <div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Save</button></div>`);
  document.getElementById('m_cancel').onclick=closeModal;
  document.getElementById('m_submit').onclick=async()=>{
    const rate=Number(document.getElementById('m_rate').value);
    if(!Number.isFinite(rate)||rate<0){alert('Enter a valid rate.');return;}
    const payload={name:document.getElementById('m_name').value.trim(),superAdminRate:rate,limit:document.getElementById('m_limit').value.trim()};
    const res=await fetch(`/api/ranges/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await res.json();if(!res.ok){alert(d.error||'Failed');return;}closeModal();rangesCatalogPage();
  };
}
function assignRangeModal(id){const agentOptions=agents.filter(a=>a.status==='active');const managerOptions=managers.filter(m=>m.status==='active');openModal(`<h3>Assign Range</h3>${currentUser.role==='super_admin'?`<div class="field"><label>Manager</label><select class="input" id="m_manager"><option value="">No manager</option>${managerOptions.map(m=>`<option value="${m.id}">${m.username}</option>`).join('')}</select></div>`:''}<div class="field"><label>Agent</label><select class="input" id="m_agent"><option value="">No agent</option>${agentOptions.map(a=>`<option value="${a.id}">${a.username}${a.managerUsername?` — ${a.managerUsername}`:''}</option>`).join('')}</select></div><div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Assign</button></div>`);document.getElementById('m_cancel').onclick=closeModal;document.getElementById('m_submit').onclick=async()=>{const payload={agentId:document.getElementById('m_agent').value||null};if(document.getElementById('m_manager'))payload.managerId=document.getElementById('m_manager').value||null;const r=await fetch(`/api/ranges/${id}/assign`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok){alert(d.error||'Failed');return;}closeModal();numbersPage();};}
}

function openRangeModal({ranges,agents,managers}) {
  const agentOptions=agents.filter(a=>a.status==='active'); const managerOptions=managers.filter(m=>m.status==='active');
  openModal(`<h3>Add Range</h3><div class="auth-error" id="modalError"></div><div class="field"><label>Range name</label><input class="input" id="m_name" placeholder="Tunisia LX 07Sep"></div><div class="field"><label>Country</label><input class="input" id="m_country" placeholder="Tunisia"></div><div class="field"><label>Operator</label><input class="input" id="m_operator" placeholder="LX"></div><div class="field"><label>Client rate per SMS ($)</label><input class="input" id="m_rate" type="number" min="0" step="0.0001" placeholder="0.0180"></div>${currentUser.role==='super_admin'?`<div class="field"><label>Manager (optional)</label><select class="input" id="m_manager"><option value="">No manager</option>${managerOptions.map(m=>`<option value="${m.id}">${m.username}</option>`).join('')}</select></div>`:''}${['super_admin','manager'].includes(currentUser.role)?`<div class="field"><label>Agent (optional)</label><select class="input" id="m_agent"><option value="">No agent</option>${agentOptions.map(a=>`<option value="${a.id}">${a.username}</option>`).join('')}</select></div>`:''}<div class="modal-actions"><button class="btn ghost" id="m_cancel">Cancel</button><button class="btn primary" id="m_submit">Create Range</button></div>`);
  document.getElementById('m_cancel').onclick=closeModal;document.getElementById('m_submit').onclick=async()=>{const payload={name:document.getElementById('m_name').value.trim(),country:document.getElementById('m_country').value.trim(),operator:document.getElementById('m_operator').value.trim(),clientRate:document.getElementById('m_rate').value};if(document.getElementById('m_manager'))payload.managerId=document.getElementById('m_manager').value||null;if(document.getElementById('m_agent'))payload.agentId=document.getElementById('m_agent').value||null;const r=await fetch('/api/ranges',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok){const e=document.getElementById('modalError');e.textContent=d.error||'Failed';e.classList.add('show');return;}closeModal();numbersPage();};
}

// ---------- Bulk Add page ----------
async function bulkAddPage() {
  content.innerHTML = `<div class="empty">Loading bulk allocation…</div>`;
  const [dataRes, historyRes] = await Promise.all([
    fetch('/api/bulk-add/targets'),
    fetch('/api/bulk-add/history')
  ]);
  const data = await dataRes.json(), historyData = await historyRes.json();
  if (!dataRes.ok) { content.innerHTML = `<div class="empty">${data.error || 'Could not load bulk allocation'}</div>`; return; }

  const targets = data.targets || [], ranges = data.ranges || [];
  const roleLabel = r => ({manager:'Manager',agent:'Agent',client:'Client'})[r] || r;

  const targetGroups = ['manager','agent','client'].map(role => {
    const items = targets.filter(t => t.role === role);
    if (!items.length) return '';
    return `<div class="bulk-group"><div class="bulk-group-title">${roleLabel(role)}</div>${
      items.map(t => `<label class="check-row"><input type="checkbox" class="bulk-target" value="${t.id}"><span>${t.username}</span></label>`).join('')
    }</div>`;
  }).join('');

  const rangeRows = ranges.map(r => `
    <div class="bulk-range-row" data-range-id="${r.id}">
      <label class="check-row">
        <input type="checkbox" class="bulk-range" value="${r.id}">
        <span class="bulk-range-name">${r.name}</span>
      </label>
      <div class="bulk-rate-wrap">
        <span class="muted">$</span>
        <input class="input bulk-range-rate" type="number" min="0" step="0.0001" value="${Number(currentUser.role==='super_admin' ? (r.superAdminRate ?? r.effectiveRate ?? 0) : (r.clientRate ?? 0)).toFixed(4)}" aria-label="${currentUser.role==='super_admin'?'Super Admin payout':'Client-facing'} rate for ${r.name}">
        <span class="muted">/ SMS</span>
      </div>
      <span class="muted">${r.availableCount || 0} free · max $${Number(r.superAdminRate ?? r.rate ?? 0).toFixed(4)}</span>
    </div>
  `).join('');

  content.innerHTML = `
    <div class="grid bulk-grid">
      <div class="card">
        <h3 style="margin-top:0">Bulk Add Numbers</h3>
        <p class="muted">Works on mobile too. Tap recipients and ranges instead of using Ctrl/⌘.</p>

        <div class="field">
          <div class="bulk-select-head"><label>Recipients</label><button class="btn small ghost" id="toggleTargets">Select all</button></div>
          <div class="bulk-checklist" id="bulkTargetsList">${targetGroups || '<div class="empty">No active recipients available.</div>'}</div>
        </div>

        <div class="field">
          <div class="bulk-select-head"><label>Ranges + ${currentUser.role==='super_admin'?'payout':'client'} rate per range</label><button class="btn small ghost" id="toggleRanges">Select all</button></div>
          <div class="bulk-checklist" id="bulkRangesList">${rangeRows || '<div class="empty">No ranges available.</div>'}</div>
          <small>${currentUser.role==='super_admin'
            ? 'Super Admin controls the base payout rate.'
            : 'You can set the rate for the selected Agent/Client recipients, but never above the Super Admin rate shown as the maximum.'}</small>
        </div>

        <div class="field">
          <label>Number amount per selected range</label>
          <input class="input" id="bulkAmount" type="number" min="1" step="1" value="100">
        </div>

        <div class="card" style="background:var(--theme-surface-2);box-shadow:none;margin-top:12px">
          <b>Example</b>
          <div class="muted" style="margin-top:6px">2 recipients × 3 ranges × 100 = up to 600 unique numbers. Every recipient receives a different set.</div>
        </div>

        <div class="modal-actions"><button class="btn primary" id="bulkSubmit">Add Numbers</button></div>
        <div class="auth-error" id="bulkError"></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Rules</h3>
        <ul>
          <li>Assigned/rented numbers are never reallocated.</li>
          <li>A number can belong to only one recipient at a time.</li>
          <li>Every recipient gets a unique random selection.</li>
          <li>Selected ranges can have different rates.</li>
        </ul>
      </div>
    </div>
    <h3 class="section-title">History</h3>
    <div id="bulkHistory"></div>
  `;

  const setAll = (selector, checked) => document.querySelectorAll(selector).forEach(x => { x.checked = checked; });
  document.getElementById('toggleTargets').onclick = () => {
    const boxes = [...document.querySelectorAll('.bulk-target')];
    const all = boxes.length && boxes.every(x => x.checked);
    setAll('.bulk-target', !all);
    document.getElementById('toggleTargets').textContent = all ? 'Select all' : 'Clear all';
  };
  document.getElementById('toggleRanges').onclick = () => {
    const boxes = [...document.querySelectorAll('.bulk-range')];
    const all = boxes.length && boxes.every(x => x.checked);
    setAll('.bulk-range', !all);
    document.getElementById('toggleRanges').textContent = all ? 'Select all' : 'Clear all';
  };

  const history = historyData.history || [];
  document.getElementById('bulkHistory').innerHTML = history.length
    ? table(['Date','Recipients','Ranges','Per range','Allocated','Progress','Status'], history.map(h => [
        new Date(h.createdAt).toLocaleString(), (h.targetNames||[]).join(', '), (h.rangeNames||[]).join(', '),
        h.amountPerRange, h.allocated, (h.summary||[]).map(x => `${x.targetUsername}: ${x.allocated}`).join(' · '), statusPill('Completed')
      ]))
    : '<div class="empty">No bulk allocations yet.</div>';

  document.getElementById('bulkSubmit').onclick = async () => {
    const targetUserIds = [...document.querySelectorAll('.bulk-target:checked')].map(x => Number(x.value));
    const selectedRows = [...document.querySelectorAll('.bulk-range:checked')].map(x => x.closest('.bulk-range-row'));
    const rangeIds = selectedRows.map(row => Number(row.dataset.rangeId));
    const rangeRates = {};
    selectedRows.forEach(row => {
      const rate = Number(row.querySelector('.bulk-range-rate').value);
      if (!Number.isFinite(rate) || rate < 0) rangeRates[row.dataset.rangeId] = NaN;
      else rangeRates[row.dataset.rangeId] = rate;
    });
    const amount = Number(document.getElementById('bulkAmount').value);
    const err = document.getElementById('bulkError'); err.classList.remove('show');

    if (!targetUserIds.length || !rangeIds.length || !Number.isInteger(amount) || amount < 1) {
      err.textContent = 'Select at least one recipient, one range, and enter a whole-number amount.';
      err.classList.add('show'); return;
    }
    if (Object.values(rangeRates).some(v => !Number.isFinite(v) || v < 0)) {
      err.textContent = 'Every selected range must have a valid rate.';
      err.classList.add('show'); return;
    }

    const btn = document.getElementById('bulkSubmit'); btn.disabled = true; btn.textContent = 'Allocating…';
    try {
      const r = await fetch('/api/bulk-add', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({targetUserIds, rangeIds, amountPerRange:amount, rangeRates})
      });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || 'Bulk allocation failed'; err.classList.add('show'); return; }
      alert(`Done — ${d.allocated} unique numbers allocated.`);
      await bulkAddPage();
    } finally {
      if (document.getElementById('bulkSubmit')) {
        document.getElementById('bulkSubmit').disabled = false;
        document.getElementById('bulkSubmit').textContent = 'Add Numbers';
      }
    }
  };
}

// ---------- CDR page (detailed reports style) ----------
function cdrEscape(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function cdrFormatDate(value) { const d=new Date(value); return Number.isNaN(d.getTime())?String(value||''):d.toLocaleString(); }
function cdrDateInput(value, endOfDay=false) { const d=new Date(value); if(Number.isNaN(d.getTime()))return ''; const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}T${endOfDay?'04:59:59':'05:00:00'}`; }
function cdrDefaultWindow() {
  const now=new Date();
  const start=new Date(now); start.setHours(5,0,0,0);
  if(now.getTime() < start.getTime()) start.setDate(start.getDate()-1);
  const end=new Date(start); end.setDate(end.getDate()+1); end.setHours(4,59,59,999);
  return {from:start,to:end};
}
function cdrRangeName(record, numberMap) { const n=numberMap.get(Number(record.numberId)); const name=record.rangeName || n?.rangeName || n?.range || ''; return String(name || '—').replace(/\bLX\b/gi,'MRS'); }
function cdrClientName(record, numberMap) {
  const n=numberMap.get(Number(record.numberId));
  const client=record.clientUsername || record.assignedClientUsername || n?.assignedClientUsername || '';
  const agent=record.agentUsername || '';
  const manager=record.managerUsername || '';
  if(currentUser.role==='super_admin') {
    // Super Admin must not see a client's username when that client belongs to an Agent.
    if(agent) return manager ? `${agent} (${manager})` : agent;
    return client || (manager ? `${manager} (Manager)` : '-') ;
  }
  if(currentUser.role==='manager') {
    // Manager sees the Agent responsible for the client; direct manager clients keep their client name.
    return agent || client || '-';
  }
  return client || '-';
}

async function cdrPage() {
  content.innerHTML=`<div class="empty">Loading CDR reports...</div>`;
  try {
    const [cdrRes,numbersRes]=await Promise.all([fetch('/api/cdr'),fetch('/api/numbers?limit=100')]);
    const cdrData=await cdrRes.json(); const numbersData=numbersRes.ok?await numbersRes.json():{numbers:[]};
    if(!cdrRes.ok){content.innerHTML=`<div class="empty">${cdrEscape(cdrData.error||'Could not load CDR')}</div>`;return;}
    let records=(Array.isArray(cdrData.cdr)?cdrData.cdr:[]).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    const numberMap=new Map((numbersData.numbers||[]).map(n=>[Number(n.id),n]));
    const defaults=cdrDefaultWindow(); const defaultFrom=defaults.from; const defaultTo=defaults.to;
    const rangeNames=[...new Set(records.map(r=>cdrRangeName(r,numberMap)).filter(x=>x&&x!=='—'))].sort((a,b)=>a.localeCompare(b));
    const clientNames=[...new Set(records.map(r=>cdrClientName(r,numberMap)).filter(x=>x&&x!=='-'))].sort((a,b)=>a.localeCompare(b));
    content.innerHTML=`<div class="cdr-report">
      <div class="breadcrumb">Home <span>»</span> CDR &amp; Statistics <span>»</span> Detailed Reports</div>
      <p class="cdr-subtitle">Detailed records of every inbound SMS</p>
      <div class="cdr-filter-card"><div class="cdr-filters">
        <div><label>From</label><input class="input" type="datetime-local" id="cdrFrom" value="${cdrDateInput(defaultFrom)}"></div>
        <div><label>To</label><input class="input" type="datetime-local" id="cdrTo" value="${cdrDateInput(defaultTo,true)}"></div>
        <div><label>Filter Range</label><select class="input" id="cdrRange"><option value="">All ranges</option>${rangeNames.map(x=>`<option value="${cdrEscape(x)}">${cdrEscape(x)}</option>`).join('')}</select></div>
        <div><label>Filter Client</label><select class="input" id="cdrClient"><option value="">All clients</option>${clientNames.map(x=>`<option value="${cdrEscape(x)}">${cdrEscape(x)}</option>`).join('')}</select></div>
        <div><label>Search Number</label><input class="input" id="cdrNumber" placeholder="Search Number"></div><div><label>Search CLI</label><input class="input" id="cdrCli" placeholder="Search CLI"></div>
        <div class="cdr-filter-actions"><button class="btn" id="cdrExport">Export Report</button><button class="btn primary" id="cdrShowReport">Show Report</button></div>
      </div><div class="cdr-groupby"><b>Group by</b>${['Hour','Day','Month','Range','Number','CLI','Client','Currency','Status'].map(x=>`<label><input type="checkbox" class="cdrGroup" value="${x}"> ${x}</label>`).join('')}</div></div>
      <div class="cdr-report-head"><b>CDR REPORTS &amp; STATS</b></div>
      <div class="cdr-tools"><div><label>Search:</label> <input class="input cdr-global-search" id="cdrSearch" placeholder="🔍 by message text or range"></div><div class="cdr-show-count">Show Records: <select class="input" id="cdrPageSize"><option>25</option><option>50</option><option>100</option></select></div></div>
      <div class="cdr-actions"><button class="btn" id="cdrCopy">Copy</button><button class="btn" id="cdrTxt">TXT</button><button class="btn" id="cdrCsv">CSV</button><button class="btn" id="cdrExcel">Excel</button><button class="btn" id="cdrColumns">Show / hide columns</button></div>
      <div id="cdrTableHost"></div></div>`;

    let filtered=records.slice(),page=1,pageSize=25; const hidden=new Set();
    const columns=['Date','Range','Number','CLI','SMS','Client','Currency','Rate / SMS','Client Payout','Status'];
    if(currentUser.role==='client') hidden.add(7);
    const getGroup=()=>[...document.querySelectorAll('.cdrGroup:checked')].map(x=>x.value);
    const groupFieldValue=(r,g)=>{
      const d=new Date(r.createdAt);
      if(g==='Hour') return d.toISOString().slice(0,13).replace('T',' ')+':00';
      if(g==='Day') return d.toISOString().slice(0,10);
      if(g==='Month') return d.toISOString().slice(0,7);
      if(g==='Range') return cdrRangeName(r,numberMap);
      if(g==='Number') return String(r.msisdn||numberMap.get(Number(r.numberId))?.msisdn||'');
      if(g==='CLI') return String(r.sender||r.cli||'');
      if(g==='Client') return cdrClientName(r,numberMap);
      if(g==='Currency') return String(r.currency||'USD');
      if(g==='Status') return r.status==='Delivered'?'Success':(r.status||'Success');
      return '';
    };
    function groupedRows(rows){
      const groups=getGroup();
      if(!groups.length)return rows.map(r=>({values:baseRow(r),count:1,payout:Number(r.myPayout??r.carrierRate??0),client:Number(r.clientPayout??0)}));
      const map=new Map();
      for(const r of rows){
        const key=groups.map(g=>groupFieldValue(r,g)).join('\u001f');
        const payout=Number(r.myPayout??r.carrierRate??0), client=Number(r.clientPayout??0), currency=String(r.currency||'USD');
        const old=map.get(key);
        if(old){old.count++;old.payout+=payout;old.client+=client;old.currencies.add(currency);}
        else map.set(key,{groupValues:groups.map(g=>groupFieldValue(r,g)),count:1,payout,client,currencies:new Set([currency])});
      }
      return [...map.values()].map(g=>{
        const values=[...g.groupValues, g.currencies.size===1?[...g.currencies][0]:'Mixed', String(g.count), `$${g.payout.toFixed(3)}`, `$${g.client.toFixed(3)}`];
        if(currentUser.role!=='client') values.push(`$${(g.payout-g.client).toFixed(3)}`);
        return {values,count:g.count,payout:g.payout,client:g.client};
      });
    }
    function groupedColumns(){
      const groups=getGroup();
      if(!groups.length)return columns;
      const labels={Hour:'Hour',Day:'Day',Month:'Month',Range:'Range',Number:'Number',CLI:'CLI',Client:'Client',Currency:'Currency',Status:'Status'};
      const out=groups.map(g=>labels[g]||g);
      if(!groups.includes('Currency')) out.push('Currency');
      out.push('SMS');
      if(currentUser.role!=='client') out.push('My Payout');
      out.push('Client Payout');
      if(currentUser.role!=='client') out.push('Profit');
      return out;
    }
    function applyFilters(){const from=new Date(document.getElementById('cdrFrom').value||'1970-01-01'),to=new Date(document.getElementById('cdrTo').value||'2999-12-31');const range=document.getElementById('cdrRange').value.toLowerCase(),client=document.getElementById('cdrClient').value.toLowerCase(),number=document.getElementById('cdrNumber').value.toLowerCase(),cli=document.getElementById('cdrCli').value.toLowerCase(),search=document.getElementById('cdrSearch').value.toLowerCase();filtered=records.filter(r=>{const dt=new Date(r.createdAt),rn=cdrRangeName(r,numberMap),cn=cdrClientName(r,numberMap),hay=`${r.note||''} ${rn}`.toLowerCase();return dt>=from&&dt<=to&&(!range||rn.toLowerCase()===range)&&(!client||cn.toLowerCase()===client)&&(!number||String(r.msisdn||'').toLowerCase().includes(number))&&(!cli||String(r.sender||'').toLowerCase().includes(cli))&&(!search||hay.includes(search));});page=1;renderCdrTable();}
    function renderCdrTable(){
      const groups=getGroup(),all=groupedRows(filtered),totalPages=Math.max(1,Math.ceil(all.length/pageSize)),start=(page-1)*pageSize,rows=all.slice(start,start+pageSize);
      const activeColumns=groupedColumns();
      const body=rows.map(g=>g.values.map((v,i)=>activeColumns[i]==='Status'
        ? statusPill(v)
        : (!groups.length && activeColumns[i]==='SMS' ? `<div class="cdr-message-cell">${cdrEscape(v)}</div>` : cdrEscape(v))));
      const totalPayout=filtered.reduce((a,r)=>a+Number(r.myPayout??r.carrierRate??0),0),totalClient=filtered.reduce((a,r)=>a+Number(r.clientPayout??0),0);
      const totalHtml=currentUser.role==='client'?`<span><b>Total SMS</b><br>${filtered.length}</span><span><b>Currency</b><br>USD</span><span><b>Client Payout</b><br>$${totalClient.toFixed(3)}</span>`:`<span><b>Total SMS</b><br>${filtered.length}</span><span><b>Currency</b><br>USD</span><span><b>My Payout</b><br>$${totalPayout.toFixed(3)}</span><span><b>Client Payout</b><br>$${totalClient.toFixed(3)}</span><span><b>Profit</b><br>$${(totalPayout-totalClient).toFixed(3)}</span>`;
      content.querySelector('#cdrTableHost').innerHTML=`${body.length?table(activeColumns,body):'<div class="empty">No CDR records match the selected filters.</div>'}<div class="cdr-total-row">${totalHtml}</div><div class="cdr-pagination"><span>Showing ${all.length?start+1:0} to ${Math.min(start+pageSize,all.length)} of ${all.length} entries${groups.length?' · grouped by '+groups.join(', '):''}</span><div><button class="btn" id="cdrFirst" ${page<=1?'disabled':''}>First</button><button class="btn" id="cdrPrev" ${page<=1?'disabled':''}>Previous</button><span class="cdr-page-number">${page}</span><button class="btn" id="cdrNext" ${page>=totalPages?'disabled':''}>Next</button><button class="btn" id="cdrLast" ${page>=totalPages?'disabled':''}>Last</button></div></div>`;
      const nav=p=>{page=Math.min(totalPages,Math.max(1,p));renderCdrTable();};
      ['cdrFirst','cdrPrev','cdrNext','cdrLast'].forEach((id,i)=>document.getElementById(id).onclick=()=>nav(i===0?1:i===1?page-1:i===2?page+1:totalPages));
    }
    function exportRows(format){
      const groups=getGroup();
      const activeColumns=groupedColumns();
      const exportIdx=groups.length ? activeColumns.map((_,i)=>i) : activeColumns.map((_,i)=>i).filter(i=>!hidden.has(i));
      const exportColumns=exportIdx.map(i=>activeColumns[i]);
      const rows=groupedRows(filtered).map(g=>exportIdx.map(i=>String(g.values[i]).replace(/\r?\n/g,' ')));
      const csv=[exportColumns,...rows].map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob=new Blob([csv],{type:format==='txt'?'text/plain;charset=utf-8':'text/csv;charset=utf-8'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`cdr-report.${format==='txt'?'txt':format==='excel'?'xls':'csv'}`;a.click();URL.revokeObjectURL(a.href);
    }
    document.getElementById('cdrShowReport').onclick=async()=>{const btn=document.getElementById('cdrShowReport');btn.disabled=true;try{const r=await fetch('/api/cdr?_refresh='+Date.now(),{cache:'no-store'});if(r.ok){const d=await r.json();records=(Array.isArray(d.cdr)?d.cdr:[]).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));}applyFilters();}finally{btn.disabled=false;}};['cdrFrom','cdrTo','cdrRange','cdrClient','cdrNumber','cdrCli'].forEach(id=>document.getElementById(id).addEventListener('change',applyFilters));document.getElementById('cdrSearch').addEventListener('input',applyFilters);document.querySelectorAll('.cdrGroup').forEach(x=>x.onchange=()=>{page=1;renderCdrTable();});document.getElementById('cdrPageSize').onchange=e=>{pageSize=Number(e.target.value);page=1;renderCdrTable();};document.getElementById('cdrCopy').onclick=async()=>{const copyIdx=columns.map((_,i)=>i).filter(i=>!hidden.has(i));const text=[copyIdx.map(i=>columns[i]),...groupedRows(filtered).map(g=>copyIdx.map(i=>g.values[i]))].map(r=>r.join('\t')).join('\n');await navigator.clipboard?.writeText(text);};document.getElementById('cdrTxt').onclick=()=>exportRows('txt');document.getElementById('cdrCsv').onclick=()=>exportRows('csv');document.getElementById('cdrExcel').onclick=()=>exportRows('excel');document.getElementById('cdrExport').onclick=()=>exportRows('csv');document.getElementById('cdrColumns').onclick=()=>{openModal(`<h3>Show / hide columns</h3><div class="column-picker">${columns.map((x,i)=>currentUser.role==='client'&&i===7?'':`<label><input type="checkbox" data-col="${i}" ${hidden.has(i)?'':'checked'}> ${x}</label>`).join('')}</div><div class="modal-actions"><button class="btn primary" id="columnSave">Apply</button></div>`);document.querySelectorAll('[data-col]').forEach(cb=>cb.onchange=()=>{const i=Number(cb.dataset.col);if(cb.checked)hidden.delete(i);else hidden.add(i);});document.getElementById('columnSave').onclick=()=>{closeModal();renderCdrTable();};};
    applyFilters();
  } catch(e){console.error(e);content.innerHTML=`<div class="empty">Could not load CDR reports: ${cdrEscape(e.message)}</div>`;}
}

// ---------- SMS Test Panel (Lamix inbound test numbers) ----------
async function testPanelPage() {
  content.innerHTML = `<div class="empty">Loading SMS Test Panel…</div>`;
  try {
    let numberPage=1, numberSize=25, inboundPage=1, inboundSize=25;
    let numberQuery='', inboundQuery='';
    let lastData=null;
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const load=async()=>{
      const params=new URLSearchParams({limit:String(numberSize),offset:String((numberPage-1)*numberSize),inboundLimit:String(inboundSize),inboundOffset:String((inboundPage-1)*inboundSize)}); if(numberQuery) params.set('search',numberQuery); if(inboundQuery) params.set('inboundSearch',inboundQuery);
      const res=await fetch('/api/test-panel?'+params.toString()+'&_='+Date.now(),{cache:'no-store'}); const d=await res.json(); if(!res.ok) throw new Error(d.error||'Could not load Lamix Test Panel');
      lastData=d; return d;
    };
    const render=async()=>{
      const d=await load(); const ns=Array.isArray(d.testNumbers)?d.testNumbers:[]; const total=Number(d.total||ns.length); const ni=Math.max(1,Math.ceil(total/numberSize)); numberPage=Math.min(numberPage,ni);
      const inbound=Array.isArray(d.recentInbound)?d.recentInbound:[]; const inboundTotal=Number(d.recentInboundTotal||inbound.length); const ri=Math.max(1,Math.ceil(inboundTotal/inboundSize)); inboundPage=Math.min(inboundPage,ri); const rs=inbound; const fullInbound=!!d.canViewFullInbound;
      content.innerHTML=`<div class="toolbar test-panel-heading" style="align-items:center;gap:12px;flex-wrap:wrap"><div><b>Test Panel</b><div class="muted">Inspect inbound traffic to test numbers. Source: Lamix Test Panel API.</div></div><button class="btn primary" id="testPanelRefresh">Refresh</button></div>
      <div class="test-panel-grid"><div class="card test-panel-card"><div class="toolbar" style="margin:0;gap:8px;align-items:center;flex-wrap:wrap"><b style="margin-right:auto">Test Numbers</b><button class="btn small" id="downloadRandomTxt">Download .txt (random)</button><button class="btn small" id="testCopy">Copy</button><button class="btn small" id="testTxt">TXT</button><button class="btn small" id="testCsv">CSV</button><button class="btn small" id="testExcel">Excel</button></div><div class="toolbar test-panel-controls" style="margin:10px 0 0;gap:8px;align-items:center"><input class="input" id="testNumberSearch" placeholder="Search: range name, prefix or number" style="min-width:0;flex:1"><select class="input" id="testNumberSize" style="width:150px"><option value="10">Show Records: 10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="250">250</option><option value="500">500</option><option value="1000">1,000</option><option value="2000">2,000</option><option value="5000">5,000</option></select></div><div style="margin-top:12px">${table(['Range','Prefix','Test Number'],ns.map(x=>[esc(x.rangeName),esc(x.prefix),`<b>${esc(x.msisdn)}</b>`]))}</div><div class="toolbar" style="justify-content:space-between;margin-top:10px"><span class="muted">Showing ${ns.length?(numberPage-1)*numberSize+1:0} to ${Math.min(numberPage*numberSize,total)} of ${total} entries</span><div><button class="btn small" id="tnPrev" ${numberPage<=1?'disabled':''}>Previous</button><span class="muted" style="margin:0 8px">${numberPage}/${ni}</span><button class="btn small" id="tnNext" ${numberPage>=ni?'disabled':''}>Next</button></div></div></div>
      <div class="card test-panel-card"><div class="toolbar" style="margin:0;gap:10px;flex-wrap:wrap"><b>Recent Inbound</b>${fullInbound?'<span class="badge">Super Admin: full CLI + message</span>':''}<input class="input" id="inboundSearch" placeholder="Search:" style="min-width:260px;flex:1"><select class="input" id="inboundSize" style="width:150px"><option value="10">Show Records: 10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="250">250</option><option value="500">500</option><option value="1000">1,000</option><option value="2000">2,000</option><option value="5000">5,000</option></select></div><div style="margin-top:12px">${table(fullInbound?['Date','Range','Number','CLI','Message']:['Date','Range','Number','CLI'],rs.map(x=>fullInbound?[new Date(x.createdAt).toLocaleString(),esc(x.rangeName),`<b>${esc(x.msisdn)}</b>`,esc(x.fullSender||x.sender),esc(x.messageBody||'—')]:[new Date(x.createdAt).toLocaleString(),esc(x.rangeName),`<b>${esc(x.msisdn)}</b>`,esc(x.sender)]))}</div><div class="toolbar" style="justify-content:space-between;margin-top:10px"><span class="muted">Showing ${rs.length?(inboundPage-1)*inboundSize+1:0} to ${Math.min((inboundPage-1)*inboundSize+rs.length,inboundTotal)} of ${inboundTotal} entries</span><div><button class="btn small" id="riPrev" ${inboundPage<=1?'disabled':''}>Previous</button><span class="muted" style="margin:0 8px">${inboundPage}/${ri}</span><button class="btn small" id="riNext" ${inboundPage>=ri?'disabled':''}>Next</button></div></div></div></div>`;
      document.getElementById('testPanelRefresh').onclick=render; document.getElementById('testNumberSearch').value=numberQuery; document.getElementById('inboundSearch').value=inboundQuery; document.getElementById('testNumberSize').value=String(numberSize); document.getElementById('inboundSize').value=String(inboundSize);
      document.getElementById('testNumberSearch').oninput=e=>{numberQuery=e.target.value.trim().toLowerCase();numberPage=1;render();}; document.getElementById('inboundSearch').oninput=e=>{inboundQuery=e.target.value.trim().toLowerCase();inboundPage=1;render();}; document.getElementById('testNumberSize').onchange=e=>{numberSize=Number(e.target.value);numberPage=1;render();}; document.getElementById('inboundSize').onchange=e=>{inboundSize=Number(e.target.value);inboundPage=1;render();};
      document.getElementById('tnPrev').onclick=()=>{numberPage--;render();}; document.getElementById('tnNext').onclick=()=>{numberPage++;render();}; document.getElementById('riPrev').onclick=()=>{inboundPage--;render();}; document.getElementById('riNext').onclick=()=>{inboundPage++;render();};
      const exportTest=(format)=>{const rows=[['Range','Prefix','Test Number'],...ns.map(x=>[x.rangeName,x.prefix,x.msisdn])];const text=rows.map(r=>r.join(format==='csv'?',':'\t')).join('\n');const blob=new Blob([text],{type:format==='csv'?'text/csv':'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`lamix-test-numbers.${format==='excel'?'xls':format}`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
      document.getElementById('testCopy').onclick=async()=>{await navigator.clipboard?.writeText(ns.map(x=>x.msisdn).join('\n'));}; document.getElementById('testTxt').onclick=()=>exportTest('txt'); document.getElementById('testCsv').onclick=()=>exportTest('csv'); document.getElementById('testExcel').onclick=()=>exportTest('excel');
      document.getElementById('downloadRandomTxt').onclick=()=>{const copy=[...ns].sort(()=>Math.random()-0.5).map(x=>x.msisdn).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([copy],{type:'text/plain'}));a.download='lamix-test-numbers-random.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
    };
    await render();
  } catch(e){console.error(e);content.innerHTML=`<div class="empty">${escapeHtml(e.message||'Could not load SMS Test Panel')}</div>`;}
}

// ---------- Users overview (Super Admin + Manager) ----------
async function usersPage() {
  if (!['super_admin','manager'].includes(currentUser.role)) {
    content.innerHTML = '<div class="empty">Users are available to Super Admins and Managers only.</div>';
    return;
  }
  content.innerHTML = '<div class="empty">Loading users…</div>';
  try {
    const res = await fetch('/api/users?_=' + Date.now(), {cache:'no-store'});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load users');
    const admins = data.admins || [];
    const esc = v => String(v ?? '').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const roleLabel = r => r === 'agent' ? 'Admin / Agent' : r;

    const adminRow = a => [
      `<b>${esc(a.username)}</b>${a.managerUsername ? ` <span class="muted">(${esc(a.managerUsername)})</span>` : ''}`,
      roleLabel(a.role),
      esc(a.email || '—'),
      `$${Number(a.balance||0).toFixed(2)}`,
      Number(a.smsCount||0),
      Number(a.successfulSms||0),
      `$${Number(a.totalEarned||0).toFixed(3)}`,
      Number(a.clientCount||0),
      a.payoutPaymentMethod === 'binance_email' ? 'Binance Email' : a.payoutPaymentMethod === 'usdt_address' ? 'USDT Address' : 'Not provided',
      a.payoutPaymentInfo ? `<span style="word-break:break-all">${esc(a.payoutPaymentInfo)}</span>` : '—',
      statusPill(a.status)
    ];

    const headers=['Admin','Role','Email','Balance','Total SMS','Successful','Earned USD','Clients','Payment Method','Payment Info','Status'];
    let body='';
    if (currentUser.role === 'super_admin') {
      const groups = new Map();
      admins.forEach(a => {
        const key = a.managerUsername || 'Admins Only';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      });
      const ordered = [...groups.entries()].sort((a,b) => {
        if (a[0] === 'Admins Only') return 1;
        if (b[0] === 'Admins Only') return -1;
        return a[0].localeCompare(b[0]);
      });
      body = ordered.map(([name, rows]) =>
        `<div class="card" style="margin-bottom:16px"><h3 style="margin-top:0">${esc(name)}${name === 'Admins Only' ? '' : ' (Manager)'}</h3>${table(headers, rows.map(adminRow))}</div>`
      ).join('');
    } else {
      body = `<div class="card">${admins.length ? table(headers, admins.map(adminRow)) : '<div class="empty">No Admins are assigned to you.</div>'}</div>`;
    }

    content.innerHTML = `
      <div class="toolbar">
        <div><h3 style="margin:0">${currentUser.role === 'super_admin' ? 'All Users' : 'My Users'}</h3>
        <div class="muted">${currentUser.role === 'super_admin' ? 'All Admins grouped by their Manager, including Admins with no Manager.' : 'Only Admins directly under you are shown.'}</div></div>
        <button class="btn" id="refreshUsers">Refresh</button>
      </div>
      ${body || '<div class="empty">No Admins found.</div>'}
    `;
    document.getElementById('refreshUsers').onclick=usersPage;
  } catch(e) {
    console.error(e);
    content.innerHTML=`<div class="empty">${String(e.message||'Could not load users').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</div>`;
  }
}

// ---------- Router ----------
async function render(name) {
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  title.textContent = name.replace(/^./, (x) => x.toUpperCase());

  if (name === 'dashboard') {
    await dashboardPage();
  } else if (name === 'managers') {
    await managersPage();
  } else if (name === 'admins') {
    await adminsPage();
  } else if (name === 'users') {
    await usersPage();
  } else if (name === 'clients') {
    await clientsPage();
  } else if (name === 'rates') {
    await ratesPage();
  } else if (name === 'test-panel') {
    await testPanelPage();
  } else if (name === 'carrier') {
    await carrierPage();
  } else if (name === 'ranges') {
    await rangesCatalogPage();
  } else if (name === 'numbers') {
    await numbersPage();
  } else if (name === 'bulk-add') {
    await bulkAddPage();
  } else if (name === 'cdr') {
    await cdrPage();
  } else if (name === 'payouts') {
    await payoutsPage();
  } else {
    content.innerHTML = mockPage(name);
    if (name === 'settings') {
      document.getElementById('saveProfile').onclick = async () => {
        const r = await fetch('/api/account/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('profileEmail').value.trim()})});
        const d = await r.json(); const m=document.getElementById('profileMsg'); m.textContent=r.ok?'Personal details saved':(d.error||'Failed'); m.classList.add('show'); if(r.ok) currentUser=d.user;
      };
      document.getElementById('changePassword').onclick = async () => {
        const r = await fetch('/api/account/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:document.getElementById('currentPassword').value,newPassword:document.getElementById('newPassword').value})});
        const d = await r.json(); const m=document.getElementById('passwordMsg'); m.textContent=r.ok?'Password changed successfully':(d.error||'Failed'); m.classList.add('show');
        if(r.ok){document.getElementById('currentPassword').value='';document.getElementById('newPassword').value='';}
      };
    }
  }
}

// ---------- Init / auth guard ----------
async function init() {
  const res = await fetch('/api/auth/me?_=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) {
    window.location.href = '/login';
    return;
  }
  const data = await res.json();
  currentUser = data.user;

  // Show only nav items allowed for this role
  document.querySelectorAll('.nav').forEach((btn) => {
    const allowedRoles = btn.dataset.role;
    if (allowedRoles && !allowedRoles.split(',').includes(currentUser.role)) {
      btn.remove();
    } else {
      btn.onclick = () => render(btn.dataset.page);
    }
  });

  // Mobile navigation: keep the full menu accessible on phones instead of hiding it.
  const mobileToggle = document.getElementById('mobileMenuToggle');
  const mobileBackdrop = document.getElementById('mobileMenuBackdrop');
  const sidebar = document.getElementById('mainSidebar');
  const closeMobileMenu = () => {
    sidebar?.classList.remove('mobile-open');
    mobileBackdrop?.classList.remove('show');
    mobileToggle?.setAttribute('aria-expanded','false');
  };
  mobileToggle?.addEventListener('click', () => {
    const open = !sidebar?.classList.contains('mobile-open');
    sidebar?.classList.toggle('mobile-open', open);
    mobileBackdrop?.classList.toggle('show', open);
    mobileToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  mobileBackdrop?.addEventListener('click', closeMobileMenu);
  document.querySelectorAll('.nav').forEach(btn => btn.addEventListener('click', closeMobileMenu));

  // Vercel serverless functions cannot keep a setInterval alive between requests.
  // Keep the carrier scanner automatic while the Super Admin panel is open.
  if (currentUser.role === 'super_admin') {
    const autoScan = async () => {
      try {
        await fetch('/api/carrier/auto-sync', { method:'POST', cache:'no-store', keepalive:true });
      } catch (_) {}
    };
    window.__mrstarkAutoScanTimer && clearInterval(window.__mrstarkAutoScanTimer);
    autoScan();
    window.__mrstarkAutoScanTimer = setInterval(autoScan, 1000);
  }

  document.getElementById('whoName').textContent = currentUser.username;
  document.getElementById('whoRole').outerHTML = roleBadge(currentUser.role);

  document.getElementById('logoutBtn').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  render('dashboard');
}

init();
