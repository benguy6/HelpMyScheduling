/**
 * AI Schedule Bot - cleaned and fixed version
 *
 * Key fixes applied:
 * 1) Removed the duplicated / stray callback-handler block that referenced undefined vars.
 * 2) Removed duplicate buildConflictKeyboard definition (kept single source).
 * 3) Replaced fragile callback routing via bot.processUpdate with direct handler functions.
 * 4) Merged the two bot.on('message') handlers into ONE, with edit-field interception first.
 *
 * Notes:
 * - Ensure you have TELEGRAM_TOKEN and OPENAI_API_KEY in .env in the same folder.
 * - This code keeps your draft-confirm flow, conflict handling, edit/delete flows, reminders, and daily summary.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const schedule = require('node-schedule');

// =====================================================
// CONFIG
// =====================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log('Telegram token loaded:', !!TELEGRAM_TOKEN);
console.log('OpenAI key loaded:', !!OPENAI_API_KEY);

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

console.log('Telegram token length:', TELEGRAM_TOKEN.length);

// =====================================================
// INIT
// =====================================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let db;

// =====================================================
// DATABASE SETUP
// =====================================================
async function initDatabase() {
  db = await open({
    filename: './schedule.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      task TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      location TEXT,
      type TEXT,
      recurrence_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (recurrence_id) REFERENCES recurrences(id)
    );

    CREATE TABLE IF NOT EXISTS recurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      task TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      location TEXT,
      type TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      chat_id TEXT PRIMARY KEY,
      default_reminder_minutes INTEGER DEFAULT 30,
      timezone TEXT DEFAULT 'UTC'
    );

    CREATE INDEX IF NOT EXISTS idx_events_chat_date ON events(chat_id, date);
    CREATE INDEX IF NOT EXISTS idx_events_datetime ON events(date, start_time);
  `);

  console.log('✅ Database initialized');
}

// =====================================================
// DRAFT SESSION STATE (in-memory)
// =====================================================
const DRAFT_TTL_MS = 90 * 1000; // 90 seconds
const CONFIRM_TTL_MS = 5 * 60 * 1000; // 5 minutes

// chatId -> { drafts: [ {id, draft, state, updatedAt, overwriteNext} ], updatedAt, editingEventId, editingField }
const sessions = new Map();

// Scheduled reminder jobs
const reminderJobs = new Map();

function nowMs() {
  return Date.now();
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { drafts: [], updatedAt: nowMs(), editingEventId: null, editingField: null });
  }
  return sessions.get(chatId);
}

function pruneExpiredDrafts() {
  const t = nowMs();
  for (const [chatId, session] of sessions.entries()) {
    session.drafts = session.drafts.filter(d => {
      const ttl = d.state === 'awaiting_confirm' ? CONFIRM_TTL_MS : DRAFT_TTL_MS;
      return (t - d.updatedAt) <= ttl;
    });
    if (session.drafts.length === 0 && (t - session.updatedAt) > DRAFT_TTL_MS) {
      // keep editing fields too (but generally safe to delete)
      sessions.delete(chatId);
    }
  }
}

setInterval(pruneExpiredDrafts, 30 * 1000);

// =====================================================
// HELPERS
// =====================================================
function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (dateStr === isoDate(today)) return 'Today';
  if (dateStr === isoDate(tomorrow)) return 'Tomorrow';

  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function normalizeTime(t) {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function escapeMarkdown(text) {
  // Keep this simple; it’s used in Markdown parse_mode messages
  return String(text).replace(/([_*[\]`])/g, '\\$1');
}

function getEventIcon(type) {
  const icons = {
    sports: '⚽',
    meeting: '💼',
    class: '📚',
    deadline: '⏰',
    social: '🎉',
    admin: '📋',
    other: '📌'
  };
  return icons[type] || '📌';
}

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

// =====================================================
// DATABASE OPERATIONS
// =====================================================
async function addEventToDB(chatId, event) {
  const result = await db.run(
    `INSERT INTO events (chat_id, task, date, start_time, end_time, location, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    chatId,
    event.task,
    event.date,
    event.start_time || null,
    event.end_time || null,
    event.location || null,
    event.type || null,
    new Date().toISOString()
  );

  const newEvent = {
    id: result.lastID,
    chat_id: chatId,
    task: event.task,
    date: event.date,
    start_time: event.start_time || null,
    end_time: event.end_time || null,
    location: event.location || null,
    type: event.type || null
  };

  await scheduleReminder(chatId, newEvent);
  return newEvent;
}

async function getEventsInRange(chatId, startDate, endDate) {
  return db.all(
    `SELECT * FROM events 
     WHERE chat_id = ? AND date >= ? AND date <= ?
     ORDER BY date, start_time`,
    chatId,
    startDate,
    endDate
  );
}

async function getAllUpcomingEvents(chatId) {
  const today = isoDate(new Date());
  return db.all(
    `SELECT * FROM events 
     WHERE chat_id = ? AND date >= ?
     ORDER BY date, start_time`,
    chatId,
    today
  );
}

async function deleteEvent(chatId, eventId) {
  await db.run('DELETE FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);
  cancelReminder(eventId);
}

async function updateEvent(chatId, eventId, updates) {
  const sets = [];
  const values = [];

  if (updates.task !== undefined) {
    sets.push('task = ?');
    values.push(updates.task);
  }
  if (updates.date !== undefined) {
    sets.push('date = ?');
    values.push(updates.date);
  }
  if (updates.start_time !== undefined) {
    sets.push('start_time = ?');
    values.push(updates.start_time);
  }
  if (updates.end_time !== undefined) {
    sets.push('end_time = ?');
    values.push(updates.end_time);
  }
  if (updates.location !== undefined) {
    sets.push('location = ?');
    values.push(updates.location);
  }
  if (updates.type !== undefined) {
    sets.push('type = ?');
    values.push(updates.type);
  }

  if (sets.length === 0) return;

  values.push(eventId, chatId);

  await db.run(
    `UPDATE events SET ${sets.join(', ')} WHERE id = ? AND chat_id = ?`,
    ...values
  );

  // Reschedule reminder
  cancelReminder(eventId);
  const event = await db.get('SELECT * FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);
  if (event) await scheduleReminder(chatId, event);
}

async function checkConflicts(chatId, date, startTime, endTime) {
  if (!startTime) return [];

  const events = await db.all(
    `SELECT * FROM events 
     WHERE chat_id = ? AND date = ? AND start_time IS NOT NULL`,
    chatId,
    date
  );

  const conflicts = [];
  const newStart = timeToMinutes(startTime);
  const newEnd = endTime ? timeToMinutes(endTime) : newStart + 60;

  for (const event of events) {
    const eventStart = timeToMinutes(event.start_time);
    const eventEnd = event.end_time ? timeToMinutes(event.end_time) : eventStart + 60;

    if (newStart < eventEnd && eventStart < newEnd) {
      conflicts.push(event);
    }
  }
  return conflicts;
}

// =====================================================
// REMINDERS
// =====================================================
async function scheduleReminder(chatId, event) {
  if (!event.start_time) return;

  const eventDateTime = new Date(`${event.date}T${event.start_time}:00`);
  const icon = getEventIcon(event.type);
  const timeLabel = event.end_time ? `${event.start_time}-${event.end_time}` : event.start_time;

  // Schedule 3 reminders: 1 day before, 6 hours before, and 30 minutes before
  const reminderOffsets = [
    { minutes: 24 * 60, label: '1 day' },      // 1 day = 1440 minutes
    { minutes: 6 * 60, label: '6 hours' },     // 6 hours = 360 minutes
    { minutes: 30, label: '30 minutes' }       // 30 minutes
  ];

  for (const offset of reminderOffsets) {
    const reminderTime = new Date(eventDateTime.getTime() - offset.minutes * 60 * 1000);

    // Only schedule if reminder time is in the future
    if (reminderTime > new Date()) {
      const jobKey = `${event.id}-${offset.minutes}`;
      
      const job = schedule.scheduleJob(reminderTime, async () => {
        await bot.sendMessage(
          chatId,
          `🔔 *Reminder* (${offset.label} before)\n\n${icon} ${escapeMarkdown(event.task)}\n📅 ${escapeMarkdown(formatDate(event.date))}\n⏰ ${escapeMarkdown(timeLabel)}`,
          { parse_mode: 'Markdown' }
        );

        reminderJobs.delete(jobKey);
      });

      reminderJobs.set(jobKey, job);
    }
  }
}

function cancelReminder(eventId) {
  // Cancel all reminders for this event (1 day, 6 hours, 30 minutes)
  const offsets = [24 * 60, 6 * 60, 30];
  
  for (const offset of offsets) {
    const jobKey = `${eventId}-${offset}`;
    const job = reminderJobs.get(jobKey);
    if (job) {
      job.cancel();
      reminderJobs.delete(jobKey);
    }
  }
}

async function rescheduleAllReminders() {
  const now = new Date();
  const events = await db.all(
    `SELECT * FROM events WHERE date >= ? AND start_time IS NOT NULL`,
    isoDate(now)
  );

  for (const event of events) {
    await scheduleReminder(event.chat_id, event);
  }

  console.log(`✅ Rescheduled ${events.length} reminders`);
}

// =====================================================
// FORMATTING
// =====================================================
function formatTaskList(tasks) {
  if (tasks.length === 0) return 'No tasks scheduled.';

  let currentDate = null;
  let message = '';

  tasks.forEach(task => {
    if (task.date !== currentDate) {
      currentDate = task.date;
      message += `\n📅 *${escapeMarkdown(formatDate(task.date))}*\n`;
    }

    const icon = getEventIcon(task.type);
    let timeLabel = null;
    if (task.start_time && task.end_time) timeLabel = `${task.start_time}-${task.end_time}`;
    else if (task.start_time) timeLabel = task.start_time;

    const timeStr = timeLabel ? `⏰ ${escapeMarkdown(timeLabel)} - ` : '• ';
    const locStr = task.location ? ` 📍 ${escapeMarkdown(task.location)}` : '';
    message += `${icon} ${timeStr}${escapeMarkdown(task.task)}${locStr}\n`;
  });

  return message.trim();
}

function makeEmptyDraft() {
  return {
    task: null,
    date: null,
    start_time: null,
    end_time: null,
    location: null,
    type: null
  };
}

function draftIsCompleteEnough(draft) {
  return !!draft.task && !!draft.date;
}

function formatDraftPreview(draft) {
  const icon = getEventIcon(draft.type);
  const dateLabel = draft.date ? formatDate(draft.date) : '(no date)';
  const timeLabel =
    draft.start_time
      ? (draft.end_time ? `${draft.start_time}-${draft.end_time}` : draft.start_time)
      : '(no time)';
  const locLabel = draft.location ? `📍 ${draft.location}` : '';
  const typeLabel = draft.type ? `🏷️ ${draft.type}` : '';

  return (
    `${icon} ${draft.task || '(no title)'}\n` +
    `📅 ${dateLabel}\n` +
    `⏰ ${timeLabel}\n` +
    (locLabel ? `${locLabel}\n` : '') +
    typeLabel
  );
}

function shouldStartNewDraftFromUpdate(currentDraft, updates, overwriteIntent) {
  if (overwriteIntent) return false;

  const newDate = updates.date;
  const hasDateAlready = !!currentDraft?.date;
  const hasOtherInfo = !!currentDraft?.task || !!currentDraft?.start_time || !!currentDraft?.location;

  if (newDate && hasDateAlready && hasOtherInfo && newDate !== currentDraft.date) {
    return true;
  }

  if (updates.task && currentDraft?.task && currentDraft?.date && updates.task !== currentDraft.task) {
    return true;
  }

  return false;
}

function mergeDraft(draft, updates, overwriteIntent, overwriteNext = false) {
  const allowOverwrite = overwriteIntent || overwriteNext;

  for (const [k, v] of Object.entries(updates)) {
    if (v == null) continue;
    if (!(k in draft)) continue;

    if (!draft[k]) {
      draft[k] = v;
    } else if (allowOverwrite) {
      draft[k] = v;
    }
  }
  return draft;
}

function buildConfirmKeyboard(draftId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: `confirm:${draftId}` },
        { text: '✏️ Edit', callback_data: `edit:${draftId}` },
        { text: '🗑️ Discard', callback_data: `discard:${draftId}` }
      ]
    ]
  };
}

function buildConflictKeyboard(draftId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Keep Both', callback_data: `conflict_keep:${draftId}` },
        { text: '♻️ Replace', callback_data: `conflict_replace:${draftId}` }
      ],
      [{ text: '❌ Cancel', callback_data: `conflict_cancel:${draftId}` }]
    ]
  };
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📅 Today', callback_data: 'menu:today' },
        { text: '📆 Week', callback_data: 'menu:week' }
      ],
      [
        { text: '⏭️ Next', callback_data: 'menu:next' },
        { text: '📋 All', callback_data: 'menu:all' }
      ],
      [
        { text: '✏️ Edit Events', callback_data: 'menu:edit' },
        { text: '🗑️ Delete Events', callback_data: 'menu:delete' }
      ],
      [{ text: '⚙️ Settings', callback_data: 'menu:settings' }]
    ]
  };
}

// =====================================================
// OPENAI PARSER
// =====================================================
async function parseScheduleMessage(message) {
  try {
    const today = isoDate(new Date());

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 650,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You extract scheduling information from chat messages.\n' +
            'Return ONLY valid JSON.\n\n' +
            'You must decide whether the message is:\n' +
            'A) a schedule update fragment (date only/time only/title only/location only), or\n' +
            'B) a multi-event bulletin or date-range (multiple dates), or\n' +
            'C) not schedule-related.\n\n' +
            'Output one of these JSON shapes:\n\n' +
            '1) Fragment update:\n' +
            '{ "kind":"updates", "success":true, "overwrite_intent": boolean, "updates": {\n' +
            '   "task": string|null,\n' +
            '   "date": "YYYY-MM-DD"|null,\n' +
            '   "start_time": "HH:MM"|null,\n' +
            '   "end_time": "HH:MM"|null,\n' +
            '   "location": string|null,\n' +
            '   "type": one of ["sports","meeting","class","deadline","social","admin","other"]|null\n' +
            '} }\n\n' +
            '2) Multi-event output:\n' +
            '{ "kind":"events", "success":true, "events":[\n' +
            '  { "task": string, "date":"YYYY-MM-DD", "start_time":"HH:MM"|null, "end_time":"HH:MM"|null, "location":string|null, "type":label|null }\n' +
            '] }\n\n' +
            '3) Not schedule-related:\n' +
            '{ "success":false, "error":"not_schedule" }\n\n' +
            'Rules:\n' +
            '- Use Current date for resolving relative dates.\n' +
            '- Convert times like "930pm" -> 21:30. Convert "9pm-11pm" into start/end.\n' +
            '- If no time is provided, use start_time=null and end_time=null.\n' +
            '- Set overwrite_intent=true if the user is correcting (words like "change", "actually", "instead").\n' +
            '- For bulletins, apply header context (title/location) to each bullet.\n' +
            '- IMPORTANT: If the user gives a DATE RANGE (e.g., "5 to 6 Jan", "5-6 Jan"), return kind:"events" and create ONE event per date in the range.\n' +
            '- Classify event types based on keywords: sports (gym, run, game), meeting (call, meeting), class (lecture, class), deadline (due, submit), social (party, dinner), admin (taxes, bills).\n'
        },
        {
          role: 'user',
          content:
            `Current date: ${today}\n\n` +
            `Message:\n"""${message}"""\n\n` +
            `Return ONLY JSON.`
        }
      ]
    });

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return { success: false, error: 'Empty model response' };

    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { success: false, error: 'Invalid JSON object' };

    if (parsed.kind === 'updates' && parsed.success === true) {
      const u = parsed.updates || {};
      const out = {
        kind: 'updates',
        success: true,
        overwrite_intent: !!parsed.overwrite_intent,
        updates: {
          task: u.task ? String(u.task).trim() : null,
          date: u.date || null,
          start_time: normalizeTime(u.start_time),
          end_time: normalizeTime(u.end_time),
          location: u.location ? String(u.location).trim() : null,
          type: u.type || null
        }
      };

      if (out.updates.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.updates.date)) {
        out.updates.date = null;
      }
      return out;
    }

    if (parsed.kind === 'events' && parsed.success === true && Array.isArray(parsed.events)) {
      const cleaned = parsed.events
        .map(ev => ({
          task: ev.task ? String(ev.task).trim() : null,
          date: ev.date || null,
          start_time: normalizeTime(ev.start_time),
          end_time: normalizeTime(ev.end_time),
          location: ev.location ? String(ev.location).trim() : null,
          type: ev.type || null
        }))
        .filter(ev => ev.task && ev.date && /^\d{4}-\d{2}-\d{2}$/.test(ev.date));

      if (cleaned.length === 0) return { success: false, error: 'No valid events extracted' };

      cleaned.sort((a, b) => {
        const da = new Date(`${a.date}T${a.start_time || '23:59'}:00`);
        const db = new Date(`${b.date}T${b.start_time || '23:59'}:00`);
        return da - db;
      });

      return { kind: 'events', success: true, events: cleaned };
    }

    return { success: false, error: parsed.error || 'Failed to parse message' };
  } catch (error) {
    console.error('AI parsing error:', error);
    if (error?.status === 401) return { success: false, error: 'invalid_api_key' };
    if (error?.status === 429) return { success: false, error: 'quota' };
    return { success: false, error: 'Failed to parse message' };
  }
}

// =====================================================
// DAILY SUMMARY
// =====================================================
async function sendDailySummary() {
  const users = await db.all('SELECT DISTINCT chat_id FROM events');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = isoDate(tomorrow);

  for (const { chat_id } of users) {
    const tasks = await db.all(
      `SELECT * FROM events WHERE chat_id = ? AND date = ? ORDER BY start_time`,
      chat_id,
      tomorrowStr
    );

    if (tasks.length > 0) {
      const message = `🌙 *Tomorrow's Schedule*\n${formatTaskList(tasks)}`;
      try {
        await bot.sendMessage(chat_id, message, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error(`Failed to send to ${chat_id}:`, error);
      }
    }
  }
}

// Daily at 9 PM server time
schedule.scheduleJob('0 21 * * *', sendDailySummary);

// =====================================================
// COMMAND HANDLERS (reused by menu callbacks)
// =====================================================
async function handleToday(chatId) {
  const today = isoDate(new Date());
  const tasks = await getEventsInRange(chatId, today, today);

  const message = tasks.length > 0
    ? `📅 *Today's Schedule*\n${formatTaskList(tasks)}`
    : `📅 *Today's Schedule*\n\nNo tasks for today!`;

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

async function handleWeek(chatId) {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  const tasks = await getEventsInRange(chatId, isoDate(start), isoDate(end));

  const message = tasks.length > 0
    ? `📆 *Next 7 Days*\n${formatTaskList(tasks)}`
    : `📆 *Next 7 Days*\n\nNo tasks this week!`;

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

async function handleAll(chatId) {
  const tasks = await getAllUpcomingEvents(chatId);

  const message = tasks.length > 0
    ? `📋 *All Upcoming Tasks*\n${formatTaskList(tasks)}`
    : `📋 *All Upcoming Tasks*\n\nNo tasks scheduled!`;

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

async function handleNext(chatId) {
  const tasks = await getAllUpcomingEvents(chatId);

  const now = new Date();
  const upcoming = tasks
    .map(t => {
      const startTime = t.start_time || '23:59';
      const dt = new Date(`${t.date}T${startTime}:00`);
      return { ...t, _dt: dt };
    })
    .filter(t => !isNaN(t._dt) && t._dt >= now)
    .sort((a, b) => a._dt - b._dt);

  if (upcoming.length === 0) {
    return bot.sendMessage(chatId, `✅ You have no upcoming tasks.`);
  }

  const next = upcoming[0];
  const icon = getEventIcon(next.type);
  const dateLabel = formatDate(next.date);
  const timeLabel = next.start_time
    ? (next.end_time ? `${next.start_time}-${next.end_time}` : next.start_time)
    : null;

  const locStr = next.location ? `\n📍 ${escapeMarkdown(next.location)}` : '';

  const message =
    `⏭️ *Next up*\n\n` +
    `${icon} ${escapeMarkdown(next.task)}\n` +
    `📅 ${escapeMarkdown(dateLabel)}` +
    (timeLabel ? ` ⏰ ${escapeMarkdown(timeLabel)}` : '') +
    locStr;

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// =====================================================
// COMMANDS
// =====================================================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Welcome to AI Schedule Bot!\n\n` +
      `Send messages like:\n` +
      `• "Meeting with Sarah tomorrow at 3pm"\n` +
      `• "Dentist appointment next Monday 10am"\n` +
      `• "Gym every Monday 6am"\n\n` +
      `Use /menu for quick access to all features!`,
    { reply_markup: buildMainMenuKeyboard() }
  );
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '📱 *Main Menu*\n\nSelect an option:',
    { parse_mode: 'Markdown', reply_markup: buildMainMenuKeyboard() }
  );
});

bot.onText(/\/today/, async (msg) => handleToday(msg.chat.id));
bot.onText(/\/week/, async (msg) => handleWeek(msg.chat.id));
bot.onText(/\/all/, async (msg) => handleAll(msg.chat.id));
bot.onText(/\/next/, async (msg) => handleNext(msg.chat.id));

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  await db.run('DELETE FROM events WHERE chat_id = ?', chatId);

  // Cancel all reminders for this user
  for (const [eventId, job] of [...reminderJobs.entries()]) {
    // We can’t reliably know chatId here after deletion; cancel all jobs for this user by reading before delete
    // But since user cleared their DB, it’s safe to cancel all current jobs and then rescheduleAllReminders.
    job.cancel();
    reminderJobs.delete(eventId);
  }

  bot.sendMessage(chatId, '🗑️ All tasks cleared!');
});

bot.onText(/\/reminder (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const minutes = parseInt(match[1], 10);

  if (Number.isNaN(minutes) || minutes < 0 || minutes > 1440) {
    bot.sendMessage(chatId, '❌ Please specify minutes between 0 and 1440 (24 hours).');
    return;
  }

  await db.run(
    `INSERT INTO settings (chat_id, default_reminder_minutes) 
     VALUES (?, ?) 
     ON CONFLICT(chat_id) DO UPDATE SET default_reminder_minutes = ?`,
    chatId,
    minutes,
    minutes
  );

  bot.sendMessage(chatId, `✅ Default reminder set to ${minutes} minutes before events.`);
});

bot.onText(/^\//, async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/') {
    bot.sendMessage(
      chatId,
      `📋 *Available Commands:*\n\n` +
        `/today - View today's events\n` +
        `/week - View next 7 days\n` +
        `/next - View next upcoming event\n` +
        `/all - View all upcoming events\n` +
        `/reminder <minutes> - Set reminder time\n` +
        `/menu - Show main menu\n` +
        `/clear - Delete all events\n`,
      { parse_mode: 'Markdown' }
    );
  }
});

// =====================================================
// CALLBACK HANDLERS
// =====================================================
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data;

  if (!chatId || !data) return;

  try {
    // MAIN MENU BUTTONS
    if (data.startsWith('menu:')) {
      const action = data.split(':')[1];
      await bot.answerCallbackQuery(query.id);

      if (action === 'today') return handleToday(chatId);
      if (action === 'week') return handleWeek(chatId);
      if (action === 'next') return handleNext(chatId);
      if (action === 'all') return handleAll(chatId);

      if (action === 'edit') {
        const events = await getAllUpcomingEvents(chatId);
        if (events.length === 0) return bot.sendMessage(chatId, '📋 No events to edit.');

        const keyboard = {
          inline_keyboard: events.map(ev => [
            {
              text: `${getEventIcon(ev.type)} ${ev.task.substring(0, 30)} (${formatDate(ev.date)})`,
              callback_data: `edit_select:${ev.id}`
            }
          ])
        };

        return bot.sendMessage(
          chatId,
          '✏️ *Select an event to edit:*',
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }

      if (action === 'delete') {
        const events = await getAllUpcomingEvents(chatId);
        if (events.length === 0) return bot.sendMessage(chatId, '📋 No events to delete.');

        const keyboard = {
          inline_keyboard: events.map(ev => [
            {
              text: `🗑️ ${ev.task.substring(0, 28)} (${formatDate(ev.date)})`,
              callback_data: `delete_confirm:${ev.id}`
            }
          ])
        };

        return bot.sendMessage(
          chatId,
          '🗑️ *Select an event to delete:*',
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }

      if (action === 'settings') {
        return bot.sendMessage(chatId, '⚙️ Settings: use /reminder <minutes> (e.g., /reminder 30).');
      }
      return;
    }

    // DRAFT BUTTONS: confirm/edit/discard
    const session = getSession(chatId);

    const getDraftOrExpire = async (draftId) => {
      const d = session.drafts.find(x => String(x.id) === String(draftId));
      if (!d) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Draft expired.' });
        return null;
      }
      return d;
    };

    if (data.startsWith('confirm:')) {
      const draftId = data.split(':')[1];
      const draftObj = await getDraftOrExpire(draftId);
      if (!draftObj) return;

      if (!draftIsCompleteEnough(draftObj.draft)) {
        await bot.answerCallbackQuery(query.id, { text: 'Need at least title + date.' });
        return;
      }

      const conflicts = await checkConflicts(
        chatId,
        draftObj.draft.date,
        draftObj.draft.start_time,
        draftObj.draft.end_time
      );

      if (conflicts.length > 0) {
        const conflictList = conflicts
          .map(c => {
            const time = c.end_time ? `${c.start_time}-${c.end_time}` : c.start_time;
            return `• ${escapeMarkdown(c.task)} (${escapeMarkdown(time)})`;
          })
          .join('\n');

        const preview = formatDraftPreview(draftObj.draft);

        await bot.editMessageText(
          `⚠️ *Time conflict detected*\n\n` +
            `*New event:*\n${preview}\n\n` +
            `*Conflicts:*\n${conflictList}\n\n` +
            `Choose an action:`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: buildConflictKeyboard(draftId)
          }
        );

        await bot.answerCallbackQuery(query.id);
        return;
      }

      const saved = await addEventToDB(chatId, draftObj.draft);
      session.drafts = session.drafts.filter(d => String(d.id) !== String(draftId));

      await bot.answerCallbackQuery(query.id, { text: 'Saved.' });
      await bot.editMessageText(
        `✅ Saved!\n\n${formatDraftPreview(saved)}`,
        { chat_id: chatId, message_id: messageId }
      );
      
      // Show next-action prompt with main menu
      await bot.sendMessage(
        chatId,
        '✨ What would you like to do next?',
        { reply_markup: buildMainMenuKeyboard() }
      );
      return;
    }

    if (data.startsWith('edit:')) {
      const draftId = data.split(':')[1];
      const draftObj = await getDraftOrExpire(draftId);
      if (!draftObj) return;

      draftObj.overwriteNext = true;
      draftObj.state = 'collecting';
      draftObj.updatedAt = nowMs();

      await bot.answerCallbackQuery(query.id, { text: 'Send the corrected info now.' });

      await bot.sendMessage(
        chatId,
        `✏️ Send the correction (e.g., "actually 6pm-7pm" or "change date to 19 Jan").\n\nCurrent draft:\n${formatDraftPreview(draftObj.draft)}`
      );
      return;
    }

    if (data.startsWith('discard:')) {
      const draftId = data.split(':')[1];
      const draftObj = await getDraftOrExpire(draftId);
      if (!draftObj) return;

      session.drafts = session.drafts.filter(d => String(d.id) !== String(draftId));

      await bot.answerCallbackQuery(query.id, { text: 'Discarded.' });
      await bot.editMessageText(
        `🗑️ Discarded draft.`,
        { chat_id: chatId, message_id: messageId }
      );
      return;
    }

    // CONFLICT FLOW
    if (data.startsWith('conflict_keep:')) {
      const draftId = data.split(':')[1];
      const draftObj = await getDraftOrExpire(draftId);
      if (!draftObj) return;

      const saved = await addEventToDB(chatId, draftObj.draft);
      session.drafts = session.drafts.filter(d => String(d.id) !== String(draftId));

      await bot.answerCallbackQuery(query.id, { text: 'Saved (kept both).' });
      await bot.editMessageText(
        `✅ Saved (kept both)!\n\n${formatDraftPreview(saved)}`,
        { chat_id: chatId, message_id: messageId }
      );
      
      // Show next-action prompt with main menu
      await bot.sendMessage(
        chatId,
        '✨ What would you like to do next?',
        { reply_markup: buildMainMenuKeyboard() }
      );
      return;
    }

    if (data.startsWith('conflict_replace:')) {
      const draftId = data.split(':')[1];
      const draftObj = await getDraftOrExpire(draftId);
      if (!draftObj) return;

      const conflicts = await checkConflicts(
        chatId,
        draftObj.draft.date,
        draftObj.draft.start_time,
        draftObj.draft.end_time
      );

      for (const c of conflicts) {
        await deleteEvent(chatId, c.id);
      }

      const saved = await addEventToDB(chatId, draftObj.draft);
      session.drafts = session.drafts.filter(d => String(d.id) !== String(draftId));

      await bot.answerCallbackQuery(query.id, { text: 'Replaced and saved.' });
      await bot.editMessageText(
        `♻️ Replaced ${conflicts.length} conflicting event(s) and saved:\n\n${formatDraftPreview(saved)}`,
        { chat_id: chatId, message_id: messageId }
      );
      
      // Show next-action prompt with main menu
      await bot.sendMessage(
        chatId,
        '✨ What would you like to do next?',
        { reply_markup: buildMainMenuKeyboard() }
      );
      return;
    }

    if (data.startsWith('conflict_cancel:')) {
      const draftId = data.split(':')[1];
      const draftObj = await getDraftOrExpire(draftId);
      if (!draftObj) return;

      draftObj.state = 'awaiting_confirm';
      draftObj.updatedAt = nowMs();

      await bot.answerCallbackQuery(query.id, { text: 'Cancelled.' });
      await bot.editMessageText(
        `Cancelled. Draft not saved.\n\n${formatDraftPreview(draftObj.draft)}`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildConfirmKeyboard(draftId)
        }
      );
      return;
    }

    // EDIT SELECTION
    if (data.startsWith('edit_select:')) {
      const eventId = Number(data.split(':')[1]);
      const event = await db.get('SELECT * FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);

      if (!event) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Event not found.' });
        return;
      }

      const preview =
        `${getEventIcon(event.type)} ${escapeMarkdown(event.task)}\n` +
        `📅 ${escapeMarkdown(formatDate(event.date))}\n` +
        `⏰ ${event.start_time ? (event.end_time ? `${event.start_time}-${event.end_time}` : event.start_time) : '(no time)'}\n` +
        (event.location ? `📍 ${escapeMarkdown(event.location)}\n` : '') +
        (event.type ? `🏷️ ${event.type}` : '');

      const keyboard = {
        inline_keyboard: [
          [
            { text: 'Change Title', callback_data: `edit_change:title:${eventId}` },
            { text: 'Change Date', callback_data: `edit_change:date:${eventId}` }
          ],
          [
            { text: 'Change Time', callback_data: `edit_change:time:${eventId}` },
            { text: 'Change Location', callback_data: `edit_change:location:${eventId}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `delete_confirm:${eventId}` },
            { text: '❌ Cancel', callback_data: 'cancel_edit' }
          ]
        ]
      };

      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `*Editing Event:*\n\n${preview}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        }
      );
      return;
    }

    // EDIT FIELD CHANGE PROMPT
    if (data.startsWith('edit_change:')) {
      const parts = data.split(':'); // edit_change:<field>:<id>
      const field = parts[1];
      const eventId = Number(parts[2]);

      const event = await db.get('SELECT * FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);
      if (!event) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Event not found.' });
        return;
      }

      session.editingEventId = eventId;
      session.editingField = field;
      session.updatedAt = nowMs();

      const fieldLabels = {
        title: 'title (e.g., "Squash game")',
        date: 'date (e.g., "18 Jan" or "2026-01-18")',
        time: 'time (e.g., "5pm-6pm" or "14:30")',
        location: 'location (e.g., "Courts 1-3")'
      };

      await bot.answerCallbackQuery(query.id, { text: 'Send the new value now.' });
      await bot.sendMessage(chatId, `Send the new ${fieldLabels[field] || field}:`);
      return;
    }

    if (data === 'cancel_edit') {
      session.editingEventId = null;
      session.editingField = null;
      await bot.answerCallbackQuery(query.id, { text: 'Cancelled.' });
      await bot.editMessageText('Edit cancelled.', { chat_id: chatId, message_id: messageId });
      return;
    }

    // DELETE CONFIRMATION
    if (data.startsWith('delete_confirm:')) {
      const eventId = Number(data.split(':')[1]);
      const event = await db.get('SELECT * FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);

      if (!event) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Event not found.' });
        return;
      }

      const preview =
        `${getEventIcon(event.type)} ${escapeMarkdown(event.task)}\n` +
        `📅 ${escapeMarkdown(formatDate(event.date))}\n` +
        `⏰ ${event.start_time ? (event.end_time ? `${event.start_time}-${event.end_time}` : event.start_time) : '(no time)'}\n` +
        (event.location ? `📍 ${escapeMarkdown(event.location)}\n` : '') +
        (event.type ? `🏷️ ${event.type}` : '');

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🗑️ Yes, Delete', callback_data: `delete_yes:${eventId}` },
            { text: '❌ Cancel', callback_data: 'cancel_delete' }
          ]
        ]
      };

      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(
        `*Are you sure?*\n\n${preview}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        }
      );
      return;
    }

    if (data.startsWith('delete_yes:')) {
      const eventId = Number(data.split(':')[1]);
      await deleteEvent(chatId, eventId);

      await bot.answerCallbackQuery(query.id, { text: '✅ Deleted.' });
      await bot.editMessageText('🗑️ Event deleted.', { chat_id: chatId, message_id: messageId });
      
      // Show next-action prompt with main menu
      await bot.sendMessage(
        chatId,
        '✨ What would you like to do next?',
        { reply_markup: buildMainMenuKeyboard() }
      );
      return;
    }

    if (data === 'cancel_delete') {
      await bot.answerCallbackQuery(query.id, { text: 'Cancelled.' });
      await bot.editMessageText('Delete cancelled.', { chat_id: chatId, message_id: messageId });
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('callback_query error:', err);
    try {
      await bot.answerCallbackQuery(query.id, { text: '❌ Error. Try again.' });
    } catch {}
  }
});

// =====================================================
// MESSAGE HANDLER (merged: edit intercept + draft session + multi-event)
// =====================================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  const session = getSession(chatId);
  session.updatedAt = nowMs();

  // Ignore commands here; command handlers already exist
  if (text.startsWith('/')) return;

  // 1) If user is editing an existing event, intercept first
  if (session.editingEventId && session.editingField) {
    const eventId = session.editingEventId;
    const field = session.editingField;

    try {
      const event = await db.get('SELECT * FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);
      if (!event) {
        await bot.sendMessage(chatId, '❌ Event not found.');
        session.editingEventId = null;
        session.editingField = null;
        return;
      }

      const updates = {};

      if (field === 'title') {
        updates.task = text;
      } else if (field === 'date') {
        const parsed = await parseScheduleMessage(text);
        if (parsed.success && parsed.kind === 'updates' && parsed.updates?.date) {
          updates.date = parsed.updates.date;
        } else {
          await bot.sendMessage(chatId, '❌ Could not parse date. Try "18 Jan" or "2026-01-18".');
          return;
        }
      } else if (field === 'time') {
        const parsed = await parseScheduleMessage(text);
        if (parsed.success && parsed.kind === 'updates' && parsed.updates) {
          // Allow clearing time by typing "no time"? Not implemented; keep as-is.
          if (parsed.updates.start_time) updates.start_time = parsed.updates.start_time;
          if (parsed.updates.end_time) updates.end_time = parsed.updates.end_time;
        } else {
          await bot.sendMessage(chatId, '❌ Could not parse time. Try "5pm-6pm" or "14:30".');
          return;
        }
      } else if (field === 'location') {
        updates.location = text;
      }

      await updateEvent(chatId, eventId, updates);

      const updatedEvent = await db.get('SELECT * FROM events WHERE id = ? AND chat_id = ?', eventId, chatId);
      const preview =
        `✅ *Updated!*\n\n` +
        `${getEventIcon(updatedEvent.type)} ${escapeMarkdown(updatedEvent.task)}\n` +
        `📅 ${escapeMarkdown(formatDate(updatedEvent.date))}\n` +
        `⏰ ${updatedEvent.start_time ? (updatedEvent.end_time ? `${updatedEvent.start_time}-${updatedEvent.end_time}` : updatedEvent.start_time) : '(no time)'}\n` +
        (updatedEvent.location ? `📍 ${escapeMarkdown(updatedEvent.location)}\n` : '') +
        (updatedEvent.type ? `🏷️ ${updatedEvent.type}` : '');

      await bot.sendMessage(chatId, preview, { parse_mode: 'Markdown' });
      
      // Show next-action prompt with main menu
      await bot.sendMessage(
        chatId,
        '✨ What would you like to do next?',
        { reply_markup: buildMainMenuKeyboard() }
      );

      session.editingEventId = null;
      session.editingField = null;
      return;
    } catch (err) {
      console.error('edit field input error:', err);
      await bot.sendMessage(chatId, '❌ Error updating event.');
      session.editingEventId = null;
      session.editingField = null;
      return;
    }
  }

  // 2) Otherwise, treat it as schedule intake (draft + multi-event)

  // Heuristic filter (keep your original idea)
  const t = text.toLowerCase();
  const scheduleKeywords = [
    'tomorrow', 'today', 'next', 'on ', 'at ', 'pm', 'am',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'jan', 'january', 'feb', 'march', 'apr', 'may', 'jun', 'july', 'aug', 'sep', 'oct', 'nov', 'dec',
    'meeting', 'call', 'dentist', 'appointment', 'gym', 'schedule', 'softball', 'game', 'deadline', 'due'
  ];
  const looksLikeSchedule = scheduleKeywords.some(k => t.includes(k));

  if (!looksLikeSchedule) {
    await bot.sendMessage(
      chatId,
      `If you'd like to add something, try:\n"18 Jan"\n"5pm-6pm"\n"Squash IHG @ Courts 1-3"`
    );
    return;
  }

  const processingMsg = await bot.sendMessage(chatId, '🤔 Processing...');

  const parsed = await parseScheduleMessage(text);

  try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch {}

  if (!parsed.success) {
    if (parsed.error === 'invalid_api_key') {
      await bot.sendMessage(chatId, '❌ OpenAI API key is invalid (401). Replace it with a correct key.');
      return;
    }
    if (parsed.error === 'quota') {
      await bot.sendMessage(chatId, '❌ OpenAI quota/rate limit (429). Check billing/limits on the API account.');
      return;
    }
    if (parsed.error === 'not_schedule') {
      await bot.sendMessage(chatId, `I didn't detect schedule info. Send a date/time/title (e.g., "18 Jan", "5pm-6pm").`);
      return;
    }
    await bot.sendMessage(chatId, `❌ I couldn't parse that. Try a date/time/title fragment.`);
    return;
  }

  // Multi-event: save immediately
  if (parsed.kind === 'events') {
    const saved = [];
    for (const ev of parsed.events) {
      saved.push(await addEventToDB(chatId, ev));
    }

    let confirm = `✅ Added *${saved.length}* event(s):\n`;
    for (const e of saved.slice(0, 8)) {
      const dateLabel = formatDate(e.date);
      const timeLabel = e.start_time ? (e.end_time ? `${e.start_time}-${e.end_time}` : e.start_time) : null;
      confirm += `\n• ${escapeMarkdown(e.task)}\n  📅 ${escapeMarkdown(dateLabel)}${timeLabel ? ` ⏰ ${escapeMarkdown(timeLabel)}` : ''}\n`;
    }
    if (saved.length > 8) confirm += `\n…and ${saved.length - 8} more.`;

    await bot.sendMessage(chatId, confirm, { parse_mode: 'Markdown' });
    return;
  }

  // Partial updates: merge into draft
  const updates = parsed.updates || {};
  const overwriteIntent = !!parsed.overwrite_intent;

  let draftObj = [...session.drafts].reverse().find(d => d.state === 'collecting');
  if (!draftObj) {
    draftObj = {
      id: String(Date.now()),
      draft: makeEmptyDraft(),
      state: 'collecting',
      updatedAt: nowMs(),
      overwriteNext: false
    };
    session.drafts.push(draftObj);
  }

  if (shouldStartNewDraftFromUpdate(draftObj.draft, updates, overwriteIntent)) {
    draftObj = {
      id: String(Date.now()),
      draft: makeEmptyDraft(),
      state: 'collecting',
      updatedAt: nowMs(),
      overwriteNext: false
    };
    session.drafts.push(draftObj);
  }

  mergeDraft(draftObj.draft, updates, overwriteIntent, draftObj.overwriteNext);
  draftObj.overwriteNext = false;
  draftObj.updatedAt = nowMs();

  if (draftIsCompleteEnough(draftObj.draft)) {
    draftObj.state = 'awaiting_confirm';
    draftObj.updatedAt = nowMs();

    const preview = formatDraftPreview(draftObj.draft);
    await bot.sendMessage(
      chatId,
      `I've prepared this event. Confirm?\n\n${preview}`,
      { reply_markup: buildConfirmKeyboard(draftObj.id) }
    );
    return;
  }

  const missing = [];
  if (!draftObj.draft.task) missing.push('title');
  if (!draftObj.draft.date) missing.push('date');

  const preview = formatDraftPreview(draftObj.draft);

  await bot.sendMessage(
    chatId,
    `Draft updated. Missing: ${missing.join(', ')}.\n\nCurrent draft:\n${preview}\n\nSend the missing part (e.g., "18 Jan", "5pm-6pm", "Squash IHG").`
  );
});

// =====================================================
// STARTUP
// =====================================================
(async () => {
  await initDatabase();
  await rescheduleAllReminders();
  console.log('🤖 Bot is running...');
  console.log('📅 Daily summaries scheduled for 9 PM');
})();
