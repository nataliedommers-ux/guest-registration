// api/interactions.js — handles office switching (block_actions) and form submission (view_submission)
const crypto = require('crypto');
const { Client } = require('@notionhq/client');
const { WebClient } = require('@slack/web-api');
const { buildView } = require('../lib/form');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
// Each env var may hold either a database ID or the ID of the Notion page that contains the database.
const OFFICE_DB = { nyc: process.env.NOTION_DB_NYC, london: process.env.NOTION_DB_LONDON };
module.exports.config = { api: { bodyParser: false } };
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function verifySlackSignature(rawBody, headers) {
  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig = headers['x-slack-signature'];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(sigBase).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(slackSig)); } catch { return false; }
}
// "14:00" → "2:00 PM"
function formatTime(time24) {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`;
}
// Resolve a database ID from either a database ID or a page ID containing one inline database. Cached per office.
const dbCache = {};
async function resolveDbId(office) {
  if (dbCache[office]) return dbCache[office];
  const id = OFFICE_DB[office];
  if (!id) return null;
  try { await notion.databases.retrieve({ database_id: id }); dbCache[office] = id; return id; } catch {}
  let cursor;
  do {
    const page = await notion.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 });
    const db = page.results.find(b => b.type === 'child_database');
    if (db) { dbCache[office] = db.id; return db.id; }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return null;
}
// Slack user → { name, email, notionUserId }. Any lookup failure degrades gracefully.
async function resolveHost(slackUserId) {
  const out = { name: null, email: null, notionUserId: null };
  if (!slackUserId) return out;
  try {
    const { user } = await slack.users.info({ user: slackUserId });
    out.name = user?.real_name || user?.profile?.real_name || user?.name || null;
    out.email = user?.profile?.email?.toLowerCase() || null;
  } catch (err) { console.error('Slack users.info error:', err?.data?.error || err.message); }
  if (!out.email) return out;
  try {
    let cursor;
    do {
      const page = await notion.users.list({ start_cursor: cursor, page_size: 100 });
      const match = page.results.find(u => u.type === 'person' && u.person?.email?.toLowerCase() === out.email);
      if (match) { out.notionUserId = match.id; break; }
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
  } catch (err) { console.error('Notion users.list error:', err?.body || err.message); }
  return out;
}
// Database schemas (column name → type), cached per database.
const schemaCache = {};
async function getSchema(dbId) {
  if (schemaCache[dbId]) return schemaCache[dbId];
  const db = await notion.databases.retrieve({ database_id: dbId });
  const schema = {};
  for (const [name, prop] of Object.entries(db.properties || {})) schema[name] = prop.type;
  schemaCache[dbId] = schema;
  return schema;
}
// Format a plain value for a Notion column of the given type.
function formatForType(type, value) {
  if (value === null || value === undefined || value === '') return undefined;
  switch (type) {
    case 'title':        return { title: [{ text: { content: String(value) } }] };
    case 'rich_text':    return { rich_text: [{ text: { content: String(value) } }] };
    case 'select':       return { select: { name: String(value) } };
    case 'status':       return { status: { name: String(value) } };
    case 'multi_select': return { multi_select: (Array.isArray(value) ? value : [value]).map(name => ({ name: String(name) })) };
    case 'email':        return { email: String(value) };
    case 'checkbox':     return { checkbox: Boolean(value) };
    case 'date':         return { date: { start: String(value) } };
    case 'people':       return { people: [{ id: String(value) }] };
    case 'url':          return { url: String(value) };
    case 'phone_number': return { phone_number: String(value) };
    case 'number':       return { number: Number(value) };
    default:             return undefined; // formulas, rollups, created_time etc. are read-only
  }
}
// Desired values per column name for each office. Values are plain; types come from the live schema.
function desiredValues(office, f, host, notes) {
  const common = {
    'Visit Date': f.visitDate,
    'Arrival Time': formatTime(f.visitTime),
    'Meeting Room': f.meetingRoom,
    'Host': host.notionUserId,
  };
  if (office === 'london') {
    return { 'Guest Name': f.guestName, ...common, 'Guest Type': f.guestType, 'Instructions': f.instructions, 'Additional Notes': notes };
  }
  return { 'Name (First and Last)': f.guestName, ...common, 'Email': f.guestEmail, 'Parkday Pass': f.parkday, 'Notes': notes };
}
// Build the Notion properties payload: only columns that exist, each in its real type.
// If the Host column isn't a people column, the host's name goes in as text instead.
async function buildProperties(dbId, office, f, host, notes) {
  const schema = await getSchema(dbId);
  const values = desiredValues(office, f, host, notes);
  if (schema['Host'] && schema['Host'] !== 'people') values['Host'] = host.name;
  const props = {};
  const missing = [];
  for (const [name, value] of Object.entries(values)) {
    const type = schema[name];
    if (!type) { if (value !== null && value !== undefined && value !== '') missing.push(name); continue; }
    const formatted = formatForType(type, value);
    if (formatted) props[name] = formatted;
  }
  // Make sure the title column is set even if its name differs from what we expect.
  const titleCol = Object.keys(schema).find(n => schema[n] === 'title');
  if (titleCol && !props[titleCol]) props[titleCol] = formatForType('title', f.guestName);
  if (missing.length) console.warn(`Columns not found in ${office} database, skipped:`, missing.join(', '));
  return props;
}
async function submit(payload, res) {
  const v = payload.view.state.values;
  let office = 'nyc';
  try { office = JSON.parse(payload.view.private_metadata || '{}').office || 'nyc'; } catch {}
  office = v.office?.office_select?.selected_option?.value || office;
  const f = {
    guestName:    v.guest_name.guest_name_input.value,
    visitDate:    v.visit_date.visit_date_picker.selected_date,
    visitTime:    v.visit_time.visit_time_picker.selected_time,
    meetingRoom:  v.meeting_room.meeting_room_input.value,
    hostSlackId:  v.host.host_select.selected_user,
    guestEmail:   v.guest_email?.guest_email_input?.value?.trim() || null,
    parkday:      (v.parkday?.parkday_check?.selected_options?.length ?? 0) > 0,
    guestType:    v.guest_type?.guest_type_select?.selected_option?.value || null,
    instructions: v.instructions?.instructions_select?.selected_option?.value || null,
  };
  let notes = v.notes?.notes_input?.value || '';
  if (office === 'nyc' && !f.guestEmail) return res.status(200).json({ response_action: 'errors', errors: { guest_email: "Please enter the guest's email address." } });
  let dbId = null;
  try { dbId = await resolveDbId(office); } catch (err) { console.error('resolveDbId error:', err?.body || err.message); }
  if (!dbId) return res.status(200).json({ response_action: 'errors', errors: { office: 'This office is not configured yet. Check the Notion connection and NOTION_DB_* settings.' } });
  const host = await resolveHost(f.hostSlackId);
  // If we can't match the host to a Notion person, keep their name in Notes so nothing is lost.
  if (!host.notionUserId && host.name) notes = [`Host: ${host.name}`, notes].filter(Boolean).join('\n');
  try {
    const properties = await buildProperties(dbId, office, f, host, notes);
    await notion.pages.create({ parent: { database_id: dbId }, properties });
  } catch (err) {
    console.error('Notion API error:', err?.body || err);
    return res.status(200).json({ response_action: 'errors', errors: { guest_name: 'Something went wrong saving to Notion. Check server logs.' } });
  }
  return res.status(200).json({ response_action: 'clear' });
}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const rawBody = await getRawBody(req);
  if (!verifySlackSignature(rawBody, req.headers)) return res.status(401).json({ error: 'Invalid Slack signature' });
  const payload = JSON.parse(new URLSearchParams(rawBody).get('payload'));
  // Office dropdown changed → swap the form fields for that office.
  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    if (action?.action_id === 'office_select' && payload.view) {
      const office = action.selected_option?.value || 'nyc';
      const hostId = payload.view.state?.values?.host?.host_select?.selected_user || payload.user?.id;
      try {
        await slack.views.update({ view_id: payload.view.id, hash: payload.view.hash, view: buildView(office, hostId) });
      } catch (err) { console.error('views.update error:', err?.data?.error || err.message); }
    }
    return res.status(200).end();
  }
  if (payload.type === 'view_submission' && payload.view.callback_id === 'guest_registration') return submit(payload, res);
  return res.status(200).end();
};
