// api/interactions.js
const crypto = require('crypto');
const { Client } = require('@notionhq/client');
const { WebClient } = require('@slack/web-api');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
// 11 Madison Office Visitors → "NYC Visitors" database
const NYC_DB = process.env.NOTION_DB_NYC;
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
// Slack user → { name, email, notionUserId }. Any lookup failure degrades gracefully.
async function resolveHost(slackUserId) {
  const out = { name: null, email: null, notionUserId: null };
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
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const rawBody = await getRawBody(req);
  if (!verifySlackSignature(rawBody, req.headers)) return res.status(401).json({ error: 'Invalid Slack signature' });
  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get('payload'));
  if (payload.type !== 'view_submission' || payload.view.callback_id !== 'guest_registration') return res.status(200).end();
  const v = payload.view.state.values;
  const guestName   = v.guest_name.guest_name_input.value;
  const visitDate   = v.visit_date.visit_date_picker.selected_date;
  const visitTime   = v.visit_time.visit_time_picker.selected_time;
  const meetingRoom = v.meeting_room.meeting_room_input.value;
  const hostSlackId = v.host.host_select.selected_user;
  const guestEmail  = v.guest_email.guest_email_input?.value?.trim() || null;
  let   notes       = v.notes.notes_input?.value || '';
  if (!NYC_DB) return res.status(200).json({ response_action: 'errors', errors: { office: 'NYC database is not configured yet.' } });
  const host = await resolveHost(hostSlackId);
  // If we can't match the host to a Notion person, keep their name in Notes so nothing is lost.
  if (!host.notionUserId && host.name) notes = [`Host: ${host.name}`, notes].filter(Boolean).join('\n');
  try {
    await notion.pages.create({
      parent: { database_id: NYC_DB },
      properties: {
        'Name (First and Last)': { title: [{ text: { content: guestName } }] },
        'Visit Date': { date: { start: visitDate } },
        'Arrival Time': { rich_text: [{ text: { content: formatTime(visitTime) } }] },
        'Meeting Room': { rich_text: [{ text: { content: meetingRoom } }] },
        ...(host.notionUserId && { 'Host': { people: [{ id: host.notionUserId }] } }),
        ...(guestEmail && { 'Email': { email: guestEmail } }),
        'Parkday Pass': { checkbox: Boolean(guestEmail) },
        ...(notes && { 'Notes': { rich_text: [{ text: { content: notes } }] } }),
      },
    });
  } catch (err) {
    console.error('Notion API error:', err?.body || err);
    return res.status(200).json({ response_action: 'errors', errors: { guest_name: 'Something went wrong saving to Notion. Check server logs.' } });
  }
  res.status(200).json({ response_action: 'clear' });
};
