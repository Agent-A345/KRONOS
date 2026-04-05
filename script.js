/* ============================================================
   KRONOS — Calendar Scheduler  |  script.js
   All vanilla JS, no external libraries
   ============================================================ */

'use strict';

/* ============================================================
   STATE
   ============================================================ */
let events = {};        // { 'YYYY-MM-DD': [eventObj, …] }
let currentView = 'month';
let today = new Date();
let cursor = new Date(today); // the "active" date for navigation
let selectedDate = null;
let activeFilter = 'all';
let searchQuery = '';
let editingEventId = null;
let pendingSavePayload = null;  // for conflict confirmation

const REMINDER_TIMEOUTS = {};   // id → timeoutId

/* ============================================================
   HELPERS
   ============================================================ */
function toKey(date) {
  // Returns YYYY-MM-DD
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatDisplayDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatMonthYear(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function getEventsForDate(key) {
  return (events[key] || []).filter(ev => matchesFilter(ev));
}

function matchesFilter(ev) {
  if (activeFilter !== 'all' && ev.category !== activeFilter) return false;
  if (searchQuery && !ev.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
  return true;
}

function getAllEvents() {
  return Object.values(events).flat();
}

/* ============================================================
   LOCAL STORAGE
   ============================================================ */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem('kronos_events');
    if (raw) events = JSON.parse(raw);
  } catch (e) {
    events = {};
  }
}

function saveToStorage() {
  localStorage.setItem('kronos_events', JSON.stringify(events));
}

/* ============================================================
   EVENT CRUD
   ============================================================ */
function saveEvent(payload) {
  const { id, date, title, time, description, category, recurrence, reminder } = payload;
  const isNew = !id;
  const eventId = id || uid();

  // Conflict detection (skip for all-day)
  if (time && !editingEventId) {
    const conflict = detectConflict(date, time, eventId);
    if (conflict) {
      showConflictModal(conflict, payload);
      return false;
    }
  }

  // Build instances for recurrence
  const instances = buildInstances(payload, eventId);

  // Remove old instances if editing recurring
  if (!isNew) {
    removeEvent(eventId, true);
  }

  instances.forEach(inst => {
    if (!events[inst.date]) events[inst.date] = [];
    events[inst.date].push(inst);
  });

  saveToStorage();
  scheduleReminder(instances[0]);
  renderAll();
  return true;
}

function buildInstances(payload, eventId) {
  const { date, title, time, description, category, recurrence, reminder } = payload;
  const base = { id: eventId, title, time: time || null, description, category, date, recurrence, reminder };

  if (!recurrence || recurrence === 'none') return [base];

  const instances = [base];
  let d = keyToDate(date);
  const limit = addDays(today, 365);

  for (let i = 1; i <= 365; i++) {
    if (recurrence === 'daily')   d = addDays(d, 1);
    else if (recurrence === 'weekly')  d = addDays(d, 7);
    else if (recurrence === 'monthly') {
      d = new Date(d);
      d.setMonth(d.getMonth() + 1);
    }
    if (d > limit) break;
    instances.push({ ...base, id: eventId, date: toKey(d) });
  }
  return instances;
}

function removeEvent(id, silent = false) {
  let removed = false;
  Object.keys(events).forEach(key => {
    const before = events[key].length;
    events[key] = events[key].filter(ev => ev.id !== id);
    if (events[key].length < before) removed = true;
    if (events[key].length === 0) delete events[key];
  });
  if (!silent) {
    saveToStorage();
    renderAll();
  }
  return removed;
}

function detectConflict(date, time, skipId) {
  const mins = timeToMinutes(time);
  const dayEvents = (events[date] || []).filter(ev => ev.time && ev.id !== skipId);
  for (const ev of dayEvents) {
    const eMins = timeToMinutes(ev.time);
    if (Math.abs(eMins - mins) < 30) return ev; // within 30-min window = conflict
  }
  return null;
}

/* ============================================================
   REMINDERS
   ============================================================ */
function scheduleReminder(ev) {
  if (!ev.reminder || ev.reminder === 'none' || !ev.time) return;

  const offsetMs = parseInt(ev.reminder) * 60000;
  const [y, m, d] = ev.date.split('-').map(Number);
  const [h, min] = ev.time.split(':').map(Number);
  const eventTime = new Date(y, m - 1, d, h, min).getTime();
  const fireAt = eventTime - offsetMs;
  const delay = fireAt - Date.now();

  if (delay <= 0) return;
  if (REMINDER_TIMEOUTS[ev.id]) clearTimeout(REMINDER_TIMEOUTS[ev.id]);

  REMINDER_TIMEOUTS[ev.id] = setTimeout(() => {
    // Prefer Notifications API, fall back to toast
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`⏰ Kronos Reminder`, { body: `${ev.title} starts in ${ev.reminder} min` });
    } else {
      showToast(`🔔 "${ev.title}" starts in ${ev.reminder} min`);
    }
  }, delay);

  // Request permission proactively
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function rescheduleAllReminders() {
  getAllEvents().forEach(scheduleReminder);
}

/* ============================================================
   SMART SUGGESTION
   ============================================================ */
function getSuggestion(dateKey) {
  const dayEvs = (events[dateKey] || []).filter(ev => ev.time).sort((a, b) => a.time.localeCompare(b.time));
  if (dayEvs.length === 0) return 'Day is free — any time works.';

  // Find first gap ≥ 30 min starting at 09:00
  let probe = 9 * 60;
  for (const ev of dayEvs) {
    const st = timeToMinutes(ev.time);
    if (st - probe >= 30) return `Free slot available at ${minutesToTime(probe)}.`;
    probe = Math.max(probe, st + 30);
  }
  if (probe < 20 * 60) return `Free slot available at ${minutesToTime(probe)}.`;
  return 'Day looks busy — consider tomorrow.';
}

/* ============================================================
   RENDER DISPATCHER
   ============================================================ */
function renderAll() {
  updateViewTitle();
  if (currentView === 'month') renderMonthView(cursor.getFullYear(), cursor.getMonth());
  else if (currentView === 'week') renderWeekView(cursor);
  else renderDayView(cursor);
  renderSidebar();
  renderInsights();
}

function updateViewTitle() {
  const el = document.getElementById('view-title');
  if (currentView === 'month') {
    el.textContent = formatMonthYear(cursor);
  } else if (currentView === 'week') {
    const s = startOfWeek(cursor);
    const e = addDays(s, 6);
    el.textContent = `${s.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
  } else {
    el.textContent = cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
}

/* ============================================================
   MONTH VIEW
   ============================================================ */
function renderMonthView(year, month) {
  const grid = document.getElementById('month-grid');
  grid.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = daysInMonth(year, month);
  const prevMonthDays = daysInMonth(year, month - 1);
  const todayKey = toKey(today);

  // Fill leading blank days
  for (let i = 0; i < firstDay; i++) {
    const day = prevMonthDays - firstDay + 1 + i;
    const key = formatKey(year, month - 1, day);
    grid.appendChild(createMonthCell(year, month - 1, day, key, true));
  }

  // Current month days
  for (let d = 1; d <= totalDays; d++) {
    const key = formatKey(year, month, d);
    grid.appendChild(createMonthCell(year, month, d, key, false));
  }

  // Trailing days
  const total = firstDay + totalDays;
  const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let d = 1; d <= trailing; d++) {
    const key = formatKey(year, month + 1, d);
    grid.appendChild(createMonthCell(year, month + 1, d, key, true));
  }
}

function createMonthCell(year, month, day, key, isOtherMonth) {
  const cell = document.createElement('div');
  cell.className = 'month-cell';
  if (isOtherMonth) cell.classList.add('other-month');

  const todayKey = toKey(today);
  if (key === todayKey) cell.classList.add('today');
  if (selectedDate && key === selectedDate) cell.classList.add('selected');

  const dayEvs = getEventsForDate(key);
  if (dayEvs.length >= 3) cell.classList.add('busy');

  cell.dataset.date = key;
  cell.setAttribute('draggable', false);
  cell.addEventListener('dragover', onCellDragOver);
  cell.addEventListener('drop', e => onCellDrop(e, key));
  cell.addEventListener('dragleave', e => cell.classList.remove('drag-over'));

  const numEl = document.createElement('div');
  numEl.className = 'cell-number';
  numEl.textContent = day;
  cell.appendChild(numEl);

  const evContainer = document.createElement('div');
  evContainer.className = 'cell-events';
  cell.appendChild(evContainer);

  const maxVisible = 3;
  dayEvs.slice(0, maxVisible).forEach(ev => {
    const pill = document.createElement('div');
    pill.className = 'event-pill';
    pill.dataset.cat = ev.category;
    pill.dataset.id = ev.id;
    pill.textContent = (ev.time ? ev.time + ' ' : '') + ev.title;
    pill.draggable = true;
    pill.addEventListener('dragstart', e => onEventDragStart(e, ev));
    pill.addEventListener('click', e => { e.stopPropagation(); openModal(key, ev); });
    evContainer.appendChild(pill);
  });

  if (dayEvs.length > maxVisible) {
    const more = document.createElement('div');
    more.className = 'event-more';
    more.textContent = `+${dayEvs.length - maxVisible} more`;
    evContainer.appendChild(more);
  }

  cell.addEventListener('click', () => {
    selectedDate = key;
    openModal(key, null);
  });

  return cell;
}

/* ============================================================
   WEEK VIEW
   ============================================================ */
function renderWeekView(date) {
  const weekStart = startOfWeek(date);
  const todayKey = toKey(today);

  // Headers
  const header = document.getElementById('week-header');
  header.innerHTML = '<div class="time-gutter"></div>';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const key = toKey(d);
    const hdr = document.createElement('div');
    hdr.className = 'week-day-header';
    if (key === todayKey) hdr.classList.add('is-today');
    hdr.innerHTML = `
      <div class="week-day-name">${d.toLocaleDateString('en-US',{weekday:'short'})}</div>
      <div class="week-day-num">${d.getDate()}</div>`;
    header.appendChild(hdr);
  }

  // Gutter
  const gutter = document.getElementById('week-gutter');
  gutter.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const g = document.createElement('div');
    g.className = 'gutter-hour';
    g.textContent = h === 0 ? '' : `${String(h).padStart(2,'0')}:00`;
    gutter.appendChild(g);
  }

  // Columns
  const cols = document.getElementById('week-columns');
  cols.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const key = toKey(d);
    const col = document.createElement('div');
    col.className = 'week-col';
    if (key === todayKey) col.classList.add('is-today');
    col.dataset.date = key;
    col.style.minHeight = '1440px';

    // Hour lines + click slots
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (h * 60) + 'px';
      line.addEventListener('click', () => openModal(key, null, minutesToTime(h * 60)));
      col.appendChild(line);
    }

    // Drag
    col.addEventListener('dragover', onCellDragOver);
    col.addEventListener('drop', e => onCellDrop(e, key));
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));

    // Events
    const dayEvs = getEventsForDate(key);
    dayEvs.forEach(ev => {
      if (!ev.time) {
        // All-day strip at top
        const strip = document.createElement('div');
        strip.className = 'all-day-strip event-block';
        strip.dataset.cat = ev.category;
        strip.dataset.id = ev.id;
        strip.style.top = '2px';
        strip.textContent = ev.title;
        strip.draggable = true;
        strip.addEventListener('dragstart', e => onEventDragStart(e, ev));
        strip.addEventListener('click', e => { e.stopPropagation(); openModal(key, ev); });
        col.appendChild(strip);
      } else {
        col.appendChild(createEventBlock(ev, key));
      }
    });

    cols.appendChild(col);
  }

  // Now line
  renderNowLine(document.getElementById('view-week'));
}

function createEventBlock(ev, dateKey) {
  const mins = timeToMinutes(ev.time);
  const block = document.createElement('div');
  block.className = 'event-block';
  block.dataset.cat = ev.category;
  block.dataset.id = ev.id;
  block.style.top = mins + 'px';
  block.style.height = '54px';
  block.draggable = true;
  block.innerHTML = `<div class="event-block-title">${ev.title}</div><div class="event-block-time">${ev.time}</div>`;
  block.addEventListener('dragstart', e => onEventDragStart(e, ev));
  block.addEventListener('click', e => { e.stopPropagation(); openModal(dateKey, ev); });
  return block;
}

/* ============================================================
   DAY VIEW
   ============================================================ */
function renderDayView(date) {
  const key = toKey(date);
  const todayKey = toKey(today);

  // Header
  const hdr = document.getElementById('day-header');
  hdr.innerHTML = `
    <div class="day-title">${date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>
    <div class="day-subtitle">${date.getFullYear()}${key === todayKey ? ' · Today' : ''}</div>`;

  // Gutter
  const gutter = document.getElementById('day-gutter');
  gutter.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const g = document.createElement('div');
    g.className = 'gutter-hour';
    g.textContent = h === 0 ? '' : `${String(h).padStart(2,'0')}:00`;
    gutter.appendChild(g);
  }

  // Column
  const col = document.getElementById('day-column');
  col.innerHTML = '';
  col.style.minHeight = '1440px';

  for (let h = 0; h < 24; h++) {
    const slot = document.createElement('div');
    slot.className = 'day-slot';
    slot.style.top = (h * 60) + 'px';
    slot.addEventListener('click', () => openModal(key, null, minutesToTime(h * 60)));
    col.appendChild(slot);
  }

  col.addEventListener('dragover', onCellDragOver);
  col.addEventListener('drop', e => onCellDrop(e, key));
  col.addEventListener('dragleave', () => col.classList.remove('drag-over'));

  const dayEvs = getEventsForDate(key);
  dayEvs.forEach(ev => {
    if (!ev.time) {
      const strip = document.createElement('div');
      strip.className = 'all-day-strip event-block';
      strip.dataset.cat = ev.category;
      strip.dataset.id = ev.id;
      strip.style.top = '2px';
      strip.textContent = ev.title;
      strip.draggable = true;
      strip.addEventListener('dragstart', e => onEventDragStart(e, ev));
      strip.addEventListener('click', e => { e.stopPropagation(); openModal(key, ev); });
      col.appendChild(strip);
    } else {
      col.appendChild(createEventBlock(ev, key));
    }
  });

  renderNowLine(document.getElementById('view-day'));
}

function renderNowLine(container) {
  const old = container.querySelector('.time-now-line');
  if (old) old.remove();

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const line = document.createElement('div');
  line.className = 'time-now-line';
  line.style.top = mins + 'px';

  // Try to place in correct column
  const col = container.querySelector('.day-column') || container.querySelector(`.week-col.is-today`);
  if (col) col.appendChild(line);
}

/* ============================================================
   SIDEBAR
   ============================================================ */
function renderSidebar() {
  const list = document.getElementById('upcoming-list');
  list.innerHTML = '';

  const upcoming = [];
  for (let i = 0; i <= 7; i++) {
    const d = addDays(today, i);
    const key = toKey(d);
    getEventsForDate(key).forEach(ev => upcoming.push({ ...ev, _date: d }));
  }

  upcoming.sort((a, b) => {
    const da = a.date + (a.time || '00:00');
    const db = b.date + (b.time || '00:00');
    return da.localeCompare(db);
  });

  if (upcoming.length === 0) {
    list.innerHTML = '<li class="upcoming-empty">No upcoming events</li>';
    return;
  }

  upcoming.forEach(ev => {
    const li = document.createElement('li');
    li.className = 'upcoming-item';
    li.dataset.cat = ev.category;
    li.innerHTML = `
      <div class="upcoming-meta">
        <div class="upcoming-title">${ev.title}</div>
        <div class="upcoming-date">${ev._date.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}${ev.time ? ' · ' + ev.time : ''}</div>
      </div>`;
    li.addEventListener('click', () => openModal(ev.date, ev));
    list.appendChild(li);
  });
}

/* ============================================================
   INSIGHTS
   ============================================================ */
function renderInsights() {
  // Busiest day of week
  const dayCounts = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  Object.keys(events).forEach(key => {
    const d = keyToDate(key);
    dayCounts[dayNames[d.getDay()]] += events[key].length;
  });
  let busiest = 'N/A';
  let max = 0;
  Object.entries(dayCounts).forEach(([day, count]) => { if (count > max) { max = count; busiest = day; } });
  document.getElementById('insight-busy').textContent = max > 0 ? busiest : '—';

  // Free hours today
  const todayKey = toKey(today);
  const timedToday = (events[todayKey] || []).filter(ev => ev.time);
  const busyMins = timedToday.length * 30; // rough estimate
  const freeHrs = Math.max(0, Math.round((480 - busyMins) / 60 * 10) / 10); // 8hr workday
  document.getElementById('insight-free').textContent = `${freeHrs}h`;

  // Events this week
  const wk = startOfWeek(today);
  let weekCount = 0;
  for (let i = 0; i < 7; i++) {
    const k = toKey(addDays(wk, i));
    weekCount += (events[k] || []).length;
  }
  document.getElementById('insight-week').textContent = weekCount;
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal(dateKey, eventObj, prefillTime) {
  const overlay = document.getElementById('modal-overlay');
  const form = document.getElementById('event-form');
  const title = document.getElementById('modal-title');
  const btnDelete = document.getElementById('btn-delete');
  const suggBox = document.getElementById('suggestion-box');

  form.reset();
  editingEventId = null;

  document.getElementById('event-date').value = dateKey;

  if (eventObj) {
    // Edit mode
    editingEventId = eventObj.id;
    title.textContent = 'Edit Event';
    document.getElementById('event-id').value = eventObj.id;
    document.getElementById('event-title').value = eventObj.title;
    document.getElementById('event-date').value = eventObj.date;
    document.getElementById('event-time').value = eventObj.time || '';
    document.getElementById('event-category').value = eventObj.category || 'work';
    document.getElementById('event-recurrence').value = eventObj.recurrence || 'none';
    document.getElementById('event-reminder').value = eventObj.reminder || 'none';
    document.getElementById('event-description').value = eventObj.description || '';
    btnDelete.classList.remove('hidden');
    suggBox.classList.add('hidden');
  } else {
    // Add mode
    title.textContent = 'New Event';
    btnDelete.classList.add('hidden');
    if (prefillTime) document.getElementById('event-time').value = prefillTime;

    // Smart suggestion
    const sug = getSuggestion(dateKey);
    document.getElementById('suggestion-text').textContent = sug;
    suggBox.classList.remove('hidden');
  }

  overlay.classList.remove('hidden');
  document.getElementById('event-title').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  editingEventId = null;
  pendingSavePayload = null;
}

/* ============================================================
   CONFLICT MODAL
   ============================================================ */
function showConflictModal(conflictingEvent, payload) {
  pendingSavePayload = payload;
  const msg = document.getElementById('conflict-msg');
  msg.textContent = `"${conflictingEvent.title}" at ${conflictingEvent.time} overlaps with your new event. Double-booking?`;
  document.getElementById('conflict-overlay').classList.remove('hidden');
}

function closeConflictModal() {
  document.getElementById('conflict-overlay').classList.add('hidden');
  pendingSavePayload = null;
}

/* ============================================================
   DRAG & DROP
   ============================================================ */
let dragPayload = null;

function onEventDragStart(e, ev) {
  dragPayload = ev;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
  setTimeout(() => e.currentTarget.classList.remove('dragging'), 0);
}

function onCellDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function onCellDrop(e, newDateKey) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!dragPayload) return;
  if (dragPayload.date === newDateKey) { dragPayload = null; return; }

  // Move event
  const ev = { ...dragPayload, date: newDateKey };
  removeEvent(dragPayload.id, true);
  if (!events[newDateKey]) events[newDateKey] = [];
  events[newDateKey].push(ev);
  saveToStorage();
  renderAll();
  showToast(`Moved "${ev.title}" to ${newDateKey}`);
  dragPayload = null;
}

/* ============================================================
   TOAST
   ============================================================ */
function showToast(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 4000);
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function navigate(direction) {
  if (currentView === 'month') {
    cursor.setMonth(cursor.getMonth() + direction);
  } else if (currentView === 'week') {
    cursor = addDays(cursor, direction * 7);
  } else {
    cursor = addDays(cursor, direction);
  }
  renderAll();
}

function goToday() {
  cursor = new Date(today);
  renderAll();
  // Scroll to current time in week/day
  setTimeout(() => {
    const nowMins = today.getHours() * 60 + today.getMinutes();
    const scrollTarget = Math.max(0, nowMins - 120);
    const body = document.querySelector('.week-body, .day-body');
    if (body) body.scrollTop = scrollTarget;
  }, 50);
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.btn-view').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  ['month', 'week', 'day'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view);
  });

  renderAll();
  if (view !== 'month') {
    setTimeout(() => {
      const nowMins = today.getHours() * 60 + today.getMinutes();
      const scrollTarget = Math.max(0, nowMins - 120);
      const body = document.querySelector('.week-body, .day-body');
      if (body) body.scrollTop = scrollTarget;
    }, 50);
  }
}

/* ============================================================
   THEME TOGGLE
   ============================================================ */
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.getElementById('btn-theme').textContent = next === 'dark' ? '☀' : '☾';
  localStorage.setItem('kronos_theme', next);
}

function loadTheme() {
  const saved = localStorage.getItem('kronos_theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('btn-theme').textContent = saved === 'dark' ? '☀' : '☾';
  } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('btn-theme').textContent = '☾';
  }
}

/* ============================================================
   SIDEBAR TOGGLE
   ============================================================ */
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  sb.classList.toggle('collapsed');
}

/* ============================================================
   INIT & EVENT LISTENERS
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  loadTheme();

  // Seed sample events if empty
  if (Object.keys(events).length === 0) seedSampleEvents();

  rescheduleAllReminders();
  renderAll();

  // Navigation
  document.getElementById('btn-prev').addEventListener('click', () => navigate(-1));
  document.getElementById('btn-next').addEventListener('click', () => navigate(1));
  document.getElementById('btn-today').addEventListener('click', goToday);

  // View toggle
  document.querySelectorAll('.btn-view').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Theme
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Sidebar
  document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);

  // FAB
  document.getElementById('fab').addEventListener('click', () => {
    const key = toKey(cursor);
    openModal(key, null);
  });

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Form submit
  document.getElementById('event-form').addEventListener('submit', e => {
    e.preventDefault();
    const titleVal = document.getElementById('event-title').value.trim();
    if (!titleVal) {
      document.getElementById('event-title').focus();
      return;
    }

    const payload = {
      id: editingEventId || null,
      title: titleVal,
      date: document.getElementById('event-date').value,
      time: document.getElementById('event-time').value || null,
      category: document.getElementById('event-category').value,
      recurrence: document.getElementById('event-recurrence').value,
      reminder: document.getElementById('event-reminder').value,
      description: document.getElementById('event-description').value.trim(),
    };

    const saved = saveEvent(payload);
    if (saved !== false) {
      closeModal();
      showToast(editingEventId ? 'Event updated ✓' : 'Event saved ✓');
    }
  });

  // Delete
  document.getElementById('btn-delete').addEventListener('click', () => {
    if (!editingEventId) return;
    if (confirm('Delete this event (and all recurrences)?')) {
      removeEvent(editingEventId);
      closeModal();
      showToast('Event deleted');
    }
  });

  // Conflict modal
  document.getElementById('conflict-cancel').addEventListener('click', closeConflictModal);
  document.getElementById('conflict-confirm').addEventListener('click', () => {
    if (!pendingSavePayload) return;
    const payload = pendingSavePayload;
    closeConflictModal();
    // Force save
    const instances = buildInstances(payload, payload.id || uid());
    instances.forEach(inst => {
      if (!events[inst.date]) events[inst.date] = [];
      events[inst.date].push(inst);
    });
    saveToStorage();
    renderAll();
    closeModal();
    showToast('Event saved (overlap allowed)');
  });

  // Toast close
  document.getElementById('toast-close').addEventListener('click', () => {
    document.getElementById('toast').classList.add('hidden');
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderAll();
  });

  // Filter chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeFilter = chip.dataset.cat;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderAll();
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
    if (!document.getElementById('modal-overlay').classList.contains('hidden')) return;

    if (e.key === 'ArrowLeft')  navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
    if (e.key === 't' || e.key === 'T') goToday();
    if (e.key === 'm') switchView('month');
    if (e.key === 'w') switchView('week');
    if (e.key === 'd') switchView('day');
    if (e.key === 'n' || e.key === 'N') document.getElementById('fab').click();
  });

  // Refresh now-line every minute
  setInterval(() => {
    if (currentView !== 'month') renderAll();
  }, 60000);
});

/* ============================================================
   SEED SAMPLE EVENTS
   ============================================================ */
function seedSampleEvents() {
  const t = new Date(today);

  function addSample(dayOffset, title, time, cat, desc) {
    const d = addDays(t, dayOffset);
    const key = toKey(d);
    if (!events[key]) events[key] = [];
    events[key].push({
      id: uid(),
      title, time, description: desc || '',
      category: cat, date: key,
      recurrence: 'none', reminder: 'none'
    });
  }

  addSample(0, 'Team standup',     '09:00', 'work',     'Daily sync');
  addSample(0, 'Lunch with Maya',  '13:00', 'personal', '');
  addSample(0, 'Code review',      '15:00', 'work',     '');
  addSample(1, 'Project planning', '10:00', 'work',     'Q2 roadmap');
  addSample(1, 'Yoga class',       '07:00', 'personal', '');
  addSample(2, 'Study ML paper',   '20:00', 'study',    'Attention is All You Need');
  addSample(3, 'Client call',      '11:00', 'work',     '');
  addSample(4, 'Movie night',      '21:00', 'personal', '');
  addSample(5, 'Weekly review',    '18:00', 'work',     '');
  addSample(-1,'Doctor appointment','10:30','personal',  '');

  saveToStorage();
}
