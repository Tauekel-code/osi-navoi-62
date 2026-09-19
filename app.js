/*
 * Цифровой диспетчер ОСИ — демо-приложение (клиентское, без бэкенда).
 * localStorage играет роль базы данных для целей демо (ТЗ п.6 в реальной
 * версии — PostgreSQL/Supabase). Всё, что касается AI, — см. ai.js.
 */

const LS_KEYS = {
  requests: 'osi_demo_requests_v1',
  audit: 'osi_demo_audit_v1',
  chat: 'osi_demo_chat_v1',
  directory: 'osi_demo_directory_v1',
  lang: 'osi_demo_lang_v1',
};

const state = {
  lang: localStorage.getItem(LS_KEYS.lang) || 'ru',
  view: 'resident',
  pendingIntent: null,
  requests: [],
  audit: [],
  chatLog: [],
  directory: { contacts: [], staff: [], faq: [], announcements: [] },
  chairman: { tab: 'board', filterCategory: 'all', filterStatus: 'all', openRequestId: null },
  staff: { currentStaffId: null },
};

function t() { return STR[state.lang]; }

// ---------- Персистентность ----------

function loadState() {
  const reqRaw = localStorage.getItem(LS_KEYS.requests);
  state.requests = reqRaw ? JSON.parse(reqRaw) : JSON.parse(JSON.stringify(SEED_REQUESTS));

  const auditRaw = localStorage.getItem(LS_KEYS.audit);
  state.audit = auditRaw ? JSON.parse(auditRaw) : [];

  const chatRaw = localStorage.getItem(LS_KEYS.chat);
  state.chatLog = chatRaw ? JSON.parse(chatRaw) : [];

  const dirRaw = localStorage.getItem(LS_KEYS.directory);
  state.directory = dirRaw ? JSON.parse(dirRaw) : {
    contacts: JSON.parse(JSON.stringify(CONTACTS)),
    staff: JSON.parse(JSON.stringify(STAFF)),
    faq: JSON.parse(JSON.stringify(FAQ)),
    announcements: JSON.parse(JSON.stringify(ANNOUNCEMENTS)),
  };
}

function persistRequests() { localStorage.setItem(LS_KEYS.requests, JSON.stringify(state.requests)); }
function persistAudit() { localStorage.setItem(LS_KEYS.audit, JSON.stringify(state.audit)); }
function persistChat() { localStorage.setItem(LS_KEYS.chat, JSON.stringify(state.chatLog)); }
function persistDirectory() { localStorage.setItem(LS_KEYS.directory, JSON.stringify(state.directory)); }

function resetDemo() {
  Object.values(LS_KEYS).forEach((k) => { if (k !== LS_KEYS.lang) localStorage.removeItem(k); });
  loadState();
  seedGreeting(true);
  renderAll();
}

// ---------- AuditLog (ТЗ п.3.27: «Все AI-решения логировать») ----------

function logAI(decision, outcome) {
  state.audit.unshift({
    at: Date.now(),
    input: decision.rawText,
    type: decision.type,
    confidence: decision.confidence,
    outcome,
  });
  state.audit = state.audit.slice(0, 100);
  persistAudit();
}

// ---------- Утилиты дома ----------

function staffById(id) { return state.directory.staff.find((s) => s.id === id); }

function isOnDutyToday(staff) {
  const day = new Date().getDay();
  return staff.workDays.includes(day);
}

function dutyForRole(role) {
  return state.directory.staff.filter((s) => s.role === role);
}

function formatWorkDays(staff) {
  return staff.workDays.map((d) => t().days[d]).join(', ');
}

function assigneeNameForCategory(category) {
  const id = CATEGORY_ASSIGNEE[category] || 'st-7';
  const s = staffById(id);
  return s ? s.name : '—';
}

// ---------- Чат: рендер ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function pushChat(sender, text, extraHtml) {
  const entry = { sender, text, extraHtml: extraHtml || null, at: Date.now() };
  state.chatLog.push(entry);
  persistChat();
  renderChatMessage(entry);
  scrollChatToBottom();
}

function renderChatMessage(entry) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${entry.sender}`;

  if (entry.sender === 'bot') {
    const lamp = document.createElement('div');
    lamp.className = 'msg-lamp';
    wrap.appendChild(lamp);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = escapeHtml(entry.text).replace(/\n/g, '<br>') + (entry.extraHtml || '');
  wrap.appendChild(bubble);

  $('#chatWindow').appendChild(wrap);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function scrollChatToBottom() {
  const w = $('#chatWindow');
  w.scrollTop = w.scrollHeight;
}

function renderChatFromLog() {
  $('#chatWindow').innerHTML = '';
  state.chatLog.forEach(renderChatMessage);
  scrollChatToBottom();
}

function seedGreeting(force) {
  if (state.chatLog.length > 0 && !force) return;
  state.chatLog = [];
  persistChat();
  pushChat('bot', t().greeting(CURRENT_RESIDENT.name));
}

// ---------- Чат: обработка ввода ----------

function ticketCardHtml(reqId) {
  const r = state.requests.find((x) => x.id === reqId);
  if (!r) return '';
  return `<div class="ticket-chip"><span class="dot ${urgencyClass(r.urgency)}"></span>№${r.id} · ${CATEGORY_LABEL[state.lang][r.category]} · ${STATUS_LABEL[state.lang][r.status]}</div>`;
}

function urgencyClass(u) {
  if (u === 'аварийная') return 'dot-alarm';
  if (u === 'высокая') return 'dot-high';
  return 'dot-calm';
}

function createTicket({ category, urgency, entrance, floor, apartment, text }) {
  const id = state.requests.length ? Math.max(...state.requests.map((r) => r.id)) + 1 : 184;
  const assigneeId = CATEGORY_ASSIGNEE[category] || 'st-7';
  const req = {
    id, category, urgency, text,
    entrance: entrance || null, floor: floor || null, apartment: apartment || CURRENT_RESIDENT.apartment,
    residentId: CURRENT_RESIDENT.id, residentName: CURRENT_RESIDENT.name,
    status: 'Новая', assigneeId,
    createdAt: Date.now(),
    history: [
      { at: Date.now(), text: 'Заявка создана ботом по обращению жителя.' },
      { at: Date.now() + 1, text: t().notifySent((staffById(assigneeId) || {}).name || '—') },
    ],
  };
  state.requests.push(req);
  persistRequests();
  renderChairmanIfActive();
  renderStaffIfActive();
  return req;
}

function getEmergencyInstruction(category, rawText) {
  const text = rawText.toLowerCase();
  if (/пожар|горит|дым/.test(text)) return { instruction: 'Если есть открытый огонь или сильный дым — звоните 101 и покиньте помещение. Не пользуйтесь лифтом.', contact: '101' };
  if (category === 'вода' || category === 'отопление') return { instruction: 'Перекройте, по возможности, вентиль под раковиной или на стояке. В затопленное помещение ниже без необходимости не заходите.', contact: staffById('st-1').phone + ' (сантехник)' };
  if (category === 'лифт') return { instruction: 'Не пытайтесь открыть двери лифта самостоятельно. Аварийная лифтовая служба на линии круглосуточно.', contact: staffById('st-5').phone + ' (лифт)' };
  if (category === 'безопасность') return { instruction: 'Не приближайтесь к посторонним/нарушителям. При угрозе жизни звоните 102. Охрана уже уведомлена.', contact: staffById('st-4').phone + ' (охрана)' };
  return { instruction: 'Ситуация зафиксирована как срочная, исполнитель уведомлён.', contact: staffById('st-7').phone + ' (председатель)' };
}

function handleCreateFlow(decision, forceEmergency) {
  const category = decision.category;
  const urgency = forceEmergency ? 'аварийная' : decision.urgency;
  const needsLocation = ['сантехника', 'электрика', 'лифт', 'домофон', 'камеры'].includes(category);
  const hasLocation = decision.entrance || decision.floor || decision.apartment || /подвал/.test(decision.rawText.toLowerCase());

  if (needsLocation && !hasLocation && urgency !== 'аварийная') {
    state.pendingIntent = { type: 'awaiting_location', category, urgency };
    pushChat('bot', t().askClarifyLocation(CATEGORY_LABEL[state.lang][category] || category));
    logAI(decision, 'clarify_location');
    return;
  }

  const req = createTicket({
    category, urgency,
    entrance: decision.entrance, floor: decision.floor, apartment: decision.apartment,
    text: decision.rawText,
  });
  logAI(decision, `created #${req.id}`);

  if (urgency === 'аварийная') {
    const { instruction, contact } = getEmergencyInstruction(category, decision.rawText);
    pushChat('bot', t().emergencyBanner(instruction, contact));
  }
  pushChat('bot', t().ticketCreated(
    req.id, assigneeNameForCategory(category), STATUS_LABEL[state.lang][req.status],
    URGENCY_LABEL[state.lang][urgency], CATEGORY_LABEL[state.lang][category],
  ), ticketCardHtml(req.id));
}

function handleDutyIntent(role) {
  if (!role) {
    const rows = state.directory.staff
      .filter((s) => s.role !== 'председатель')
      .map((s) => `${isOnDutyToday(s) ? '🟢' : '⚪'} ${s.name} — ${ROLE_LABEL[state.lang][s.role]}`)
      .join('\n');
    pushChat('bot', `${t().dutyFullRoster}\n${rows}`);
    return;
  }
  const candidates = dutyForRole(role);
  if (!candidates.length) { pushChat('bot', t().dutyUnknownRole); return; }
  const onDuty = candidates.find(isOnDutyToday);
  const roleLabel = ROLE_LABEL[state.lang][role] || role;
  if (onDuty) {
    pushChat('bot', t().dutyFound(roleLabel, onDuty.name, onDuty.phone, onDuty.hours));
  } else {
    const c = candidates[0];
    pushChat('bot', t().dutyNotToday(roleLabel, c.name, c.phone, formatWorkDays(c)));
    state.pendingIntent = { type: 'offer_ticket_for_role', role };
  }
}

function handleContactIntent(role) {
  const candidates = dutyForRole(role);
  if (!candidates.length) { pushChat('bot', t().contactUnknownRole); return; }
  const c = candidates[0];
  pushChat('bot', t().contactFound(ROLE_LABEL[state.lang][role] || role, c.name, c.phone));
}

function handleMyRequests() {
  const mine = state.requests.filter((r) => r.residentId === CURRENT_RESIDENT.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!mine.length) { pushChat('bot', t().myRequestsNone); return; }
  const lines = mine.map((r) => `№${r.id} · ${CATEGORY_LABEL[state.lang][r.category]} · ${STATUS_LABEL[state.lang][r.status]}`).join('\n');
  pushChat('bot', `${t().myRequestsHeader}\n${lines}`);
}

function handleAnnouncements() {
  const lines = state.directory.announcements
    .slice().sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((a) => `• ${a.title} (${a.date}): ${a.text}`).join('\n');
  pushChat('bot', `${t().announcementsHeader}\n${lines}`);
}

function handleContactsMenu() {
  const lines = state.directory.contacts.map((c) => `${c.label}: ${c.phone}`).join('\n');
  pushChat('bot', lines);
}

function handleUnknown(decision) {
  logAI(decision, 'unknown');
  pushChat('bot', t().unknown, `
    <div class="chip-row">
      <button class="chip" data-action="unknown-create">${t().unknownCreateBtn}</button>
      <button class="chip" data-action="unknown-escalate">${t().unknownEscalateBtn}</button>
    </div>`);
}

function handleFreeText(rawText) {
  if (state.pendingIntent) {
    const pending = state.pendingIntent;
    state.pendingIntent = null;

    if (pending.type === 'awaiting_location') {
      const entities = extractEntities(rawText.toLowerCase());
      const req = createTicket({ category: pending.category, urgency: pending.urgency, ...entities, text: rawText });
      pushChat('bot', t().ticketCreated(
        req.id, assigneeNameForCategory(pending.category), STATUS_LABEL[state.lang][req.status],
        URGENCY_LABEL[state.lang][pending.urgency], CATEGORY_LABEL[state.lang][pending.category],
      ), ticketCardHtml(req.id));
      return;
    }
    if (pending.type === 'force_category' || pending.type === 'force_emergency') {
      const decision = classify(rawText, state.directory.faq);
      const category = decision.category || 'другое';
      handleCreateFlow({ ...decision, category, urgency: pending.type === 'force_emergency' ? 'аварийная' : decision.urgency }, pending.type === 'force_emergency');
      return;
    }
  }

  const decision = classify(rawText, state.directory.faq);

  if (decision.type === 'intent') {
    if (decision.intent === 'duty') { logAI(decision, 'duty'); handleDutyIntent(decision.role); return; }
    if (decision.intent === 'contact') { logAI(decision, 'contact'); handleContactIntent(decision.role); return; }
    if (decision.intent === 'my_requests') { logAI(decision, 'my_requests'); handleMyRequests(); return; }
    if (decision.intent === 'announcements') { logAI(decision, 'announcements'); handleAnnouncements(); return; }
  }
  if (decision.type === 'request') { handleCreateFlow(decision, decision.urgency === 'аварийная'); return; }
  if (decision.type === 'faq') { logAI(decision, `faq:${decision.faq.id}`); pushChat('bot', decision.faq.answer); return; }
  handleUnknown(decision);
}

function handleMenuClick(key) {
  const label = t().menu[key];
  pushChat('user', label);
  window.setTimeout(() => {
    if (key === 'request') { state.pendingIntent = { type: 'force_category' }; pushChat('bot', t().askDescribeRequest); return; }
    if (key === 'emergency') { state.pendingIntent = { type: 'force_emergency' }; pushChat('bot', t().askDescribeEmergency); return; }
    if (key === 'contacts') { handleContactsMenu(); return; }
    if (key === 'duty') { handleDutyIntent(null); return; }
    if (key === 'myRequests') { handleMyRequests(); return; }
    if (key === 'announcements') { handleAnnouncements(); return; }
    if (key === 'askHouse') { state.pendingIntent = { type: 'faq_prompt' }; pushChat('bot', state.lang === 'ru' ? 'Спрашивайте: про парковку, тихие часы, мусор, собрание, животных, оплату.' : 'Сұраңыз: тұрақ, тыныштық сағаттары, қоқыс, жиналыс, жануарлар, төлем туралы.'); return; }
  }, 250);
}

// ---------- Обработчики UI ----------

function onSend(e) {
  e.preventDefault();
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text) return;
  pushChat('user', text);
  input.value = '';
  autoGrow(input);
  window.setTimeout(() => handleFreeText(text), 350);
}

function autoGrow(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function onChatClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'unknown-create') {
    state.pendingIntent = { type: 'force_category' };
    pushChat('user', t().unknownCreateBtn);
    window.setTimeout(() => pushChat('bot', t().askDescribeRequest), 250);
  }
  if (btn.dataset.action === 'unknown-escalate') {
    pushChat('user', t().unknownEscalateBtn);
    window.setTimeout(() => pushChat('bot', t().escalated), 250);
  }
}

function onAttach(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pushChat('user', state.lang === 'ru' ? '📷 Фото приложено' : '📷 Фото тіркелді', `<img class="chat-photo" src="${reader.result}" alt="">`);
    e.target.value = '';
  };
  reader.readAsDataURL(file);
}

// ---------- Рендер: переключатель Житель/Председатель ----------

function setView(view) {
  state.view = view;
  $('#app').dataset.view = view;
  $$('.view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'chairman') renderChairman();
  if (view === 'staff') renderStaffView();
}

function renderChairmanIfActive() { if (state.view === 'chairman') renderChairman(); }
function renderStaffIfActive() { if (state.view === 'staff') renderStaffView(); }

// ---------- Рендер статических подписей ----------

function renderChrome() {
  document.documentElement.lang = state.lang === 'kz' ? 'kk' : 'ru';
  $('#appName').textContent = t().appName;
  $('#houseTag').textContent = t().houseTag;
  $('#chatTitle').textContent = t().chatTitle;
  $('#chatOnline').textContent = t().chatOnline;
  $('#messageInput').placeholder = t().inputPlaceholder;
  $('#sendBtn').textContent = t().send;
  $('#resetBtn').textContent = t().resetDemo;
  $$('.view-switch button')[0].textContent = t().tabResident;
  $$('.view-switch button')[1].textContent = t().tabChairman;
  $$('.view-switch button')[2].textContent = t().tabStaff;
  $('#staffPersonaLabel').textContent = t().staffPersonaLabel;
  $('#staffNewHeader').textContent = t().staffNewHeader;
  $('#staffActiveHeader').textContent = t().staffActiveHeader;
  $('#staffDoneHeader').textContent = t().staffDoneHeader;

  const menuWrap = $('#quickMenu');
  menuWrap.innerHTML = '';
  Object.keys(t().menu).forEach((key) => {
    const b = document.createElement('button');
    b.className = 'chip menu-chip';
    b.textContent = t().menu[key];
    b.addEventListener('click', () => handleMenuClick(key));
    menuWrap.appendChild(b);
  });

  $('#demoBadge').textContent = t().demoBadge;
  $('#attachBtn').title = t().attach;
  $('#tabBoardBtn').textContent = t().tabBoard;
  $('#tabDirectoryBtn').textContent = t().tabDirectory;

  $('#pitchTitle').textContent = t().pitchTitle(HOUSE.name);
  $('#pitchLead').textContent = t().pitchLead;
  $('#pitchHintViews').textContent = t().pitchHintViews;
  const examplesWrap = $('#pitchExamples');
  examplesWrap.innerHTML = '';
  t().pitchExamples.forEach((ex) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pitch-example';
    b.textContent = ex;
    b.addEventListener('click', () => {
      pushChat('user', ex);
      window.setTimeout(() => handleFreeText(ex), 350);
    });
    examplesWrap.appendChild(b);
  });
}

// ---------- Панель председателя ----------

function isOverdue(r) {
  if (r.status === 'Выполнена' || r.status === 'Закрыта') return false;
  const hours = (Date.now() - r.createdAt) / 3600000;
  const limit = r.urgency === 'аварийная' ? 2 : r.urgency === 'высокая' ? 24 : 48;
  return hours > limit;
}

function isClosedToday(r) {
  if (r.status !== 'Закрыта' && r.status !== 'Выполнена') return false;
  const last = r.history[r.history.length - 1];
  if (!last) return false;
  const d1 = new Date(last.at), d2 = new Date();
  return d1.toDateString() === d2.toDateString();
}

function renderChairman() {
  renderStatCards();
  renderRequestsBoard();
  renderDutySidebar();
  renderDirectoryTabs();
  renderAuditLog();
}

function renderStatCards() {
  const needsAttention = state.requests.filter((r) => r.status === 'Новая' || isOverdue(r)).length;
  const inProgress = state.requests.filter((r) => r.status === 'В работе' || r.status === 'Принята').length;
  const overdue = state.requests.filter(isOverdue).length;
  const closedToday = state.requests.filter(isClosedToday).length;

  $('#statNeedsAttention .stat-num').textContent = needsAttention;
  $('#statInProgress .stat-num').textContent = inProgress;
  $('#statOverdue .stat-num').textContent = overdue;
  $('#statClosedToday .stat-num').textContent = closedToday;

  $('#statNeedsAttention .stat-label').textContent = t().statNeedsAttention;
  $('#statInProgress .stat-label').textContent = t().statInProgress;
  $('#statOverdue .stat-label').textContent = t().statOverdue;
  $('#statClosedToday .stat-label').textContent = t().statClosedToday;
  $('#aiSummaryBtn').textContent = t().aiSummaryBtn;
}

function statusClass(status) {
  return 'status-' + status.replace(/[^a-zA-Zа-яА-Я]/g, '').toLowerCase();
}

function renderRequestsBoard() {
  const catSel = $('#filterCategory');
  const statSel = $('#filterStatus');
  if (!catSel.dataset.built) {
    catSel.innerHTML = `<option value="all">${t().filterAllCategories}</option>` +
      CATEGORIES.map((c) => `<option value="${c}">${CATEGORY_LABEL[state.lang][c]}</option>`).join('');
    statSel.innerHTML = `<option value="all">${t().filterAllStatuses}</option>` +
      STATUS_FLOW.map((s) => `<option value="${s}">${STATUS_LABEL[state.lang][s]}</option>`).join('');
    catSel.dataset.built = '1';
    catSel.addEventListener('change', () => { state.chairman.filterCategory = catSel.value; renderRequestsBoard(); });
    statSel.addEventListener('change', () => { state.chairman.filterStatus = statSel.value; renderRequestsBoard(); });
  } else {
    catSel.querySelectorAll('option').forEach((o, i) => { if (i > 0) o.textContent = CATEGORY_LABEL[state.lang][o.value]; else o.textContent = t().filterAllCategories; });
    statSel.querySelectorAll('option').forEach((o, i) => { if (i > 0) o.textContent = STATUS_LABEL[state.lang][o.value]; else o.textContent = t().filterAllStatuses; });
  }

  let list = state.requests.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (state.chairman.filterCategory !== 'all') list = list.filter((r) => r.category === state.chairman.filterCategory);
  if (state.chairman.filterStatus !== 'all') list = list.filter((r) => r.status === state.chairman.filterStatus);

  const wrap = $('#requestsList');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-hint">—</div>`;
    return;
  }
  list.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'req-row' + (isOverdue(r) ? ' req-overdue' : '');
    row.dataset.id = r.id;
    const loc = [r.entrance ? `под. ${r.entrance}` : null, r.floor ? `эт. ${r.floor}` : null, r.apartment ? `кв. ${r.apartment}` : null].filter(Boolean).join(', ') || '—';
    row.innerHTML = `
      <span class="dot ${urgencyClass(r.urgency)}"></span>
      <span class="req-id">№${r.id}</span>
      <span class="req-cat">${CATEGORY_LABEL[state.lang][r.category]}</span>
      <span class="req-loc">${loc}</span>
      <span class="req-status ${statusClass(r.status)}">${STATUS_LABEL[state.lang][r.status]}</span>
      <span class="req-assignee">${(staffById(r.assigneeId) || {}).name || '—'}</span>
    `;
    row.addEventListener('click', () => openRequestModal(r.id));
    wrap.appendChild(row);
  });
}

function renderDutySidebar() {
  $('#dutyTodayHeader').textContent = t().dutyTodayHeader;
  const wrap = $('#dutyList');
  wrap.innerHTML = '';
  state.directory.staff.filter((s) => s.role !== 'председатель').forEach((s) => {
    const on = isOnDutyToday(s);
    const row = document.createElement('div');
    row.className = 'duty-row';
    row.innerHTML = `<span class="dot ${on ? 'dot-calm' : 'dot-off'}"></span><div><div class="duty-name">${s.name}</div><div class="duty-role">${ROLE_LABEL[state.lang][s.role]} · ${s.hours}</div></div>`;
    wrap.appendChild(row);
  });
}

function openRequestModal(id) {
  const r = state.requests.find((x) => x.id === id);
  if (!r) return;
  state.chairman.openRequestId = id;

  const modal = $('#requestModal');
  const loc = [r.entrance ? `подъезд ${r.entrance}` : null, r.floor ? `этаж ${r.floor}` : null, r.apartment ? `кв. ${r.apartment}` : null].filter(Boolean).join(', ') || '—';

  $('#modalTitle').textContent = `№${r.id} · ${CATEGORY_LABEL[state.lang][r.category]}`;
  $('#modalMeta').innerHTML = `<span class="dot ${urgencyClass(r.urgency)}"></span> ${URGENCY_LABEL[state.lang][r.urgency]} · ${loc} · ${r.residentName}`;
  $('#modalText').textContent = r.text;

  const catSelect = $('#modalCategory');
  catSelect.innerHTML = CATEGORIES.map((c) => `<option value="${c}" ${c === r.category ? 'selected' : ''}>${CATEGORY_LABEL[state.lang][c]}</option>`).join('');
  const staffSelect = $('#modalAssignee');
  staffSelect.innerHTML = state.directory.staff.map((s) => `<option value="${s.id}" ${s.id === r.assigneeId ? 'selected' : ''}>${s.name}</option>`).join('');
  const statusSelect = $('#modalStatus');
  statusSelect.innerHTML = STATUS_FLOW.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${STATUS_LABEL[state.lang][s]}</option>`).join('');

  $('#modalAiNote').textContent = `${t().aiSuggested}: ${CATEGORY_LABEL[state.lang][r.category]} → ${(staffById(CATEGORY_ASSIGNEE[r.category]) || {}).name || '—'}`;
  $('#modalOverrideLabel').textContent = t().override;
  $('#modalCategoryLabel').textContent = t().labelCategory;
  $('#modalAssigneeLabel').textContent = t().labelAssignee;
  $('#modalStatusLabel').textContent = t().labelStatus;

  $('#modalHistory').innerHTML = r.history.slice().reverse().map((h) => `<div class="hist-row"><span class="hist-time">${new Date(h.at).toLocaleString(state.lang === 'kz' ? 'kk-KZ' : 'ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><span>${h.text}</span></div>`).join('');

  $('#requestCardHistory').textContent = t().requestCardHistory;
  $('#modalSaveBtn').textContent = t().save;
  $('#modalCloseBtn').textContent = t().close;

  modal.classList.add('open');
}

function closeRequestModal() { $('#requestModal').classList.remove('open'); state.chairman.openRequestId = null; }

function saveRequestModal() {
  const id = state.chairman.openRequestId;
  const r = state.requests.find((x) => x.id === id);
  if (!r) return;
  const newCategory = $('#modalCategory').value;
  const newAssignee = $('#modalAssignee').value;
  const newStatus = $('#modalStatus').value;

  const changes = [];
  if (newCategory !== r.category) changes.push(`Категория изменена председателем: ${r.category} → ${newCategory}.`);
  if (newAssignee !== r.assigneeId) changes.push(`Ответственный изменён председателем: ${(staffById(r.assigneeId) || {}).name} → ${(staffById(newAssignee) || {}).name}.`);
  if (newStatus !== r.status) changes.push(`Статус изменён: ${r.status} → ${newStatus}.`);

  r.category = newCategory; r.assigneeId = newAssignee; r.status = newStatus;
  changes.forEach((c) => r.history.push({ at: Date.now(), text: c }));
  if (!changes.length) r.history.push({ at: Date.now(), text: 'Просмотрено председателем, изменений нет.' });

  persistRequests();
  closeRequestModal();
  renderChairman();
}

function computeAiSummary() {
  const today = new Date().toDateString();
  const todays = state.requests.filter((r) => new Date(r.createdAt).toDateString() === today);
  const catCount = {};
  state.requests.forEach((r) => { if (r.status !== 'Закрыта') catCount[r.category] = (catCount[r.category] || 0) + 1; });
  const topCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, n]) => `${CATEGORY_LABEL[state.lang][c]} (${n})`).join(', ');
  const overdue = state.requests.filter(isOverdue);
  const needsAttention = state.requests.filter((r) => r.status === 'Новая');

  return [
    `${state.lang === 'ru' ? 'Всего обращений сегодня' : 'Бүгінгі өтінімдер'}: ${todays.length}.`,
    `${state.lang === 'ru' ? 'Основные категории' : 'Негізгі санаттар'}: ${topCats || '—'}.`,
    `${state.lang === 'ru' ? 'Просрочено' : 'Мерзімі өткен'}: ${overdue.length}${overdue.length ? ' (№' + overdue.map((r) => r.id).join(', №') + ')' : ''}.`,
    `${state.lang === 'ru' ? 'Требуют внимания' : 'Назар аудару керек'}: ${needsAttention.length}${needsAttention.length ? ' (№' + needsAttention.map((r) => r.id).join(', №') + ')' : ''}.`,
  ].join('\n');
}

function openAiSummary() {
  $('#aiSummaryHeading').textContent = t().aiSummaryHeading;
  $('#aiSummaryBody').textContent = computeAiSummary();
  $('#aiSummaryCloseBtn').textContent = t().close;
  $('#aiSummaryModal').classList.add('open');
}

function renderAuditLog() {
  $('#tabAuditLabel').textContent = t().tabAudit;
  const wrap = $('#auditList');
  if (!state.audit.length) { wrap.innerHTML = `<div class="empty-hint">${t().auditEmpty}</div>`; return; }
  wrap.innerHTML = state.audit.map((a) => `
    <div class="audit-row">
      <span class="audit-time">${new Date(a.at).toLocaleTimeString(state.lang === 'kz' ? 'kk-KZ' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="audit-input">«${a.input}»</span>
      <span class="audit-arrow">→</span>
      <span class="audit-outcome">${a.outcome}</span>
      <span class="audit-conf">${Math.round(a.confidence * 100)}%</span>
    </div>`).join('');
}

// ---------- Исполнитель (роль сотрудника/подрядчика) ----------

function eligibleStaffForPersona() {
  return state.directory.staff.filter((s) => s.role !== 'председатель');
}

function ensureStaffPersona() {
  const list = eligibleStaffForPersona();
  if (!list.length) { state.staff.currentStaffId = null; return; }
  if (!list.find((s) => s.id === state.staff.currentStaffId)) {
    state.staff.currentStaffId = list[0].id;
  }
}

function staffCardHtml(r) {
  const loc = [r.entrance ? `под. ${r.entrance}` : null, r.floor ? `эт. ${r.floor}` : null, r.apartment ? `кв. ${r.apartment}` : null].filter(Boolean).join(', ') || '—';
  const residentPhone = r.residentId === CURRENT_RESIDENT.id ? CURRENT_RESIDENT.phone : '—';
  return `
    <div class="staff-card ${r.urgency === 'аварийная' ? 'staff-card-alarm' : ''}" data-id="${r.id}">
      <div class="staff-card-top">
        <span class="dot ${urgencyClass(r.urgency)}"></span>
        <span class="staff-card-id">№${r.id}</span>
        <span class="staff-card-cat">${CATEGORY_LABEL[state.lang][r.category]}</span>
        <span class="staff-card-loc">${loc}</span>
      </div>
      <div class="staff-card-text">${escapeHtml(r.text)}</div>
      <div class="staff-card-meta">
        <span class="staff-card-resident">${r.residentName} · ${residentPhone}</span>
        <div class="staff-card-actions">
          <select class="staff-status-select" data-id="${r.id}">
            ${STATUS_FLOW.map((st) => `<option value="${st}" ${st === r.status ? 'selected' : ''}>${STATUS_LABEL[state.lang][st]}</option>`).join('')}
          </select>
          <button type="button" class="chip staff-update-btn" data-id="${r.id}">${t().staffUpdateBtn}</button>
        </div>
      </div>
    </div>`;
}

function renderStaffView() {
  ensureStaffPersona();
  const list = eligibleStaffForPersona();
  const personaSelect = $('#staffPersona');
  personaSelect.innerHTML = list.map((s) => `<option value="${s.id}" ${s.id === state.staff.currentStaffId ? 'selected' : ''}>${s.name} — ${ROLE_LABEL[state.lang][s.role] || s.role}</option>`).join('');

  const current = staffById(state.staff.currentStaffId);
  const onDuty = current ? isOnDutyToday(current) : false;
  const badge = $('#staffOnDutyBadge');
  badge.textContent = onDuty ? t().staffOnDuty : t().staffOffDuty;
  badge.className = 'staff-onduty ' + (onDuty ? 'on' : 'off');

  const mine = state.requests.filter((r) => r.assigneeId === state.staff.currentStaffId);
  const isNew = (r) => r.status === 'Новая';
  const isActive = (r) => r.status === 'Принята' || r.status === 'В работе' || r.status === 'Ожидает';
  const isDone = (r) => r.status === 'Выполнена' || r.status === 'Закрыта';

  const fill = (elId, items) => {
    const el = $(elId);
    el.innerHTML = items.length ? items.sort((a, b) => b.createdAt - a.createdAt).map(staffCardHtml).join('') : `<div class="empty-hint">${t().staffNoTickets}</div>`;
  };
  fill('#staffNewCards', mine.filter(isNew));
  fill('#staffActiveCards', mine.filter(isActive));
  fill('#staffDoneCards', mine.filter(isDone));

  $$('.staff-update-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id, 10);
      const select = document.querySelector(`.staff-status-select[data-id="${id}"]`);
      const req = state.requests.find((r) => r.id === id);
      if (!req || !select) return;
      const newStatus = select.value;
      if (newStatus !== req.status) {
        req.history.push({ at: Date.now(), text: t().staffStatusChangedBy(STATUS_LABEL[state.lang][req.status], STATUS_LABEL[state.lang][newStatus]) });
        req.status = newStatus;
        persistRequests();
        renderStaffView();
        renderChairmanIfActive();
      }
    });
  });
}

// ---------- Справочники (Контакты / Сотрудники / FAQ / Объявления) ----------

function renderDirectoryTabs() {
  $('#directoryContactsLabel').textContent = t().directoryContacts;
  $('#directoryStaffLabel').textContent = t().directoryStaff;
  $('#directoryFaqLabel').textContent = t().directoryFaq;
  $('#directoryAnnouncementsLabel').textContent = t().directoryAnnouncements;

  renderContactsEditor();
  renderStaffEditor();
  renderFaqEditor();
  renderAnnouncementsEditor();
}

function directoryRowActions(onDelete) {
  const btn = document.createElement('button');
  btn.className = 'chip chip-danger';
  btn.textContent = t().delete;
  btn.addEventListener('click', onDelete);
  return btn;
}

function renderContactsEditor() {
  const wrap = $('#contactsEditor');
  wrap.innerHTML = '';
  state.directory.contacts.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'dir-row';
    row.innerHTML = `<span>${c.label}</span><span class="dir-mono">${c.phone}</span>`;
    row.appendChild(directoryRowActions(() => {
      state.directory.contacts = state.directory.contacts.filter((x) => x.id !== c.id);
      persistDirectory(); renderContactsEditor();
    }));
    wrap.appendChild(row);
  });

  $('#contactAddForm').onsubmit = (e) => {
    e.preventDefault();
    const label = $('#contactLabelInput').value.trim();
    const phone = $('#contactPhoneInput').value.trim();
    if (!label || !phone) return;
    state.directory.contacts.push({ id: 'c-' + Date.now(), label, phone });
    persistDirectory();
    e.target.reset();
    renderContactsEditor();
  };
  $('#contactLabelInput').placeholder = t().fieldLabel;
  $('#contactPhoneInput').placeholder = t().fieldPhone;
  $('#contactAddBtn').textContent = t().addItem;
}

function renderStaffEditor() {
  const wrap = $('#staffEditor');
  wrap.innerHTML = '';
  state.directory.staff.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'dir-row';
    row.innerHTML = `<span>${s.name}</span><span>${ROLE_LABEL[state.lang][s.role] || s.role}</span><span class="dir-mono">${s.phone}</span><span>${formatWorkDays(s)}, ${s.hours}</span>`;
    row.appendChild(directoryRowActions(() => {
      state.directory.staff = state.directory.staff.filter((x) => x.id !== s.id);
      persistDirectory(); renderStaffEditor(); renderDutySidebar();
    }));
    wrap.appendChild(row);
  });

  $('#staffAddForm').onsubmit = (e) => {
    e.preventDefault();
    const name = $('#staffNameInput').value.trim();
    const role = $('#staffRoleInput').value.trim();
    const phone = $('#staffPhoneInput').value.trim();
    if (!name || !role || !phone) return;
    state.directory.staff.push({ id: 'st-' + Date.now(), name, role, type: 'employee', phone, zone: '', workDays: [1, 2, 3, 4, 5], hours: '09:00–18:00' });
    persistDirectory();
    e.target.reset();
    renderStaffEditor(); renderDutySidebar();
  };
  $('#staffNameInput').placeholder = t().fieldName;
  $('#staffRoleInput').placeholder = t().fieldRole;
  $('#staffPhoneInput').placeholder = t().fieldPhone;
  $('#staffAddBtn').textContent = t().addItem;
}

function renderFaqEditor() {
  const wrap = $('#faqEditor');
  wrap.innerHTML = '';
  state.directory.faq.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'dir-row dir-row-wrap';
    row.innerHTML = `<span class="dir-strong">${f.question}</span><span>${f.answer}</span>`;
    row.appendChild(directoryRowActions(() => {
      state.directory.faq = state.directory.faq.filter((x) => x.id !== f.id);
      persistDirectory(); renderFaqEditor();
    }));
    wrap.appendChild(row);
  });

  $('#faqAddForm').onsubmit = (e) => {
    e.preventDefault();
    const question = $('#faqQuestionInput').value.trim();
    const answer = $('#faqAnswerInput').value.trim();
    const keywords = $('#faqKeywordsInput').value.trim();
    if (!question || !answer || !keywords) return;
    state.directory.faq.push({ id: 'faq-' + Date.now(), question, answer, keywords: keywords.split(',').map((k) => k.trim().toLowerCase()) });
    persistDirectory();
    e.target.reset();
    renderFaqEditor();
  };
  $('#faqQuestionInput').placeholder = t().fieldQuestion;
  $('#faqAnswerInput').placeholder = t().fieldAnswer;
  $('#faqKeywordsInput').placeholder = t().fieldKeywords;
  $('#faqAddBtn').textContent = t().addItem;
}

function renderAnnouncementsEditor() {
  const wrap = $('#announcementsEditor');
  wrap.innerHTML = '';
  state.directory.announcements.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'dir-row dir-row-wrap';
    row.innerHTML = `<span class="dir-strong">${a.title}</span><span class="dir-mono">${a.date}</span><span>${a.text}</span>`;
    row.appendChild(directoryRowActions(() => {
      state.directory.announcements = state.directory.announcements.filter((x) => x.id !== a.id);
      persistDirectory(); renderAnnouncementsEditor();
    }));
    wrap.appendChild(row);
  });

  $('#annAddForm').onsubmit = (e) => {
    e.preventDefault();
    const title = $('#annTitleInput').value.trim();
    const text = $('#annTextInput').value.trim();
    const date = $('#annDateInput').value || new Date().toISOString().slice(0, 10);
    if (!title || !text) return;
    state.directory.announcements.push({ id: 'an-' + Date.now(), title, text, date });
    persistDirectory();
    e.target.reset();
    renderAnnouncementsEditor();
  };
  $('#annTitleInput').placeholder = t().fieldTitle;
  $('#annTextInput').placeholder = t().fieldText;
  $('#annAddBtn').textContent = t().addItem;
}

// ---------- Вкладки председателя ----------

function setChairmanTab(tabKey) {
  state.chairman.tab = tabKey;
  $$('.chair-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabKey));
  $$('.chair-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tabKey));
}

// ---------- Инициализация ----------

function renderAll() {
  renderChrome();
  renderChatFromLog();
  if (state.view === 'chairman') renderChairman();
  if (state.view === 'staff') renderStaffView();
}

function setLang(lang) {
  state.lang = lang;
  localStorage.setItem(LS_KEYS.lang, lang);
  $$('.lang-switch button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  renderAll();
}

function wireEvents() {
  $('#chatForm').addEventListener('submit', onSend);
  $('#messageInput').addEventListener('input', (e) => autoGrow(e.target));
  $('#messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); }
  });
  $('#chatWindow').addEventListener('click', onChatClick);
  $('#attachInput').addEventListener('change', onAttach);
  $('#attachBtn').addEventListener('click', () => $('#attachInput').click());

  $$('.view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('.lang-switch button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  $('#resetBtn').addEventListener('click', () => {
    if (confirm(state.lang === 'ru' ? 'Сбросить демо-данные к исходным?' : 'Демо деректерін бастапқы күйге келтіру керек пе?')) resetDemo();
  });

  $('#aiSummaryBtn').addEventListener('click', openAiSummary);
  $('#aiSummaryCloseBtn').addEventListener('click', () => $('#aiSummaryModal').classList.remove('open'));
  $('#aiSummaryModal').addEventListener('click', (e) => { if (e.target.id === 'aiSummaryModal') $('#aiSummaryModal').classList.remove('open'); });

  $('#modalCloseBtn').addEventListener('click', closeRequestModal);
  $('#modalSaveBtn').addEventListener('click', saveRequestModal);
  $('#requestModal').addEventListener('click', (e) => { if (e.target.id === 'requestModal') closeRequestModal(); });

  $$('.chair-tabs button').forEach((b) => b.addEventListener('click', () => setChairmanTab(b.dataset.tab)));

  $('#staffPersona').addEventListener('change', (e) => {
    state.staff.currentStaffId = e.target.value;
    renderStaffView();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  wireEvents();
  setView('resident');
  $$('.lang-switch button').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
  renderAll();
  seedGreeting(false);
});
