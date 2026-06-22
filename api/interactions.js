// api/interactions.js
const crypto = require('crypto');
const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const OFFICE_DB = {
  nyc: process.env.NOTION_DB_NYC,
  sf: process.env.NOTION_DB_SF,
  london: process.env.NOTION_DB_LONDON,
};
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
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const rawBody = await getRawBody(req);
  if (!verifySlackSignature(rawBody, req.headers)) return res.status(401).json({ error: 'Invalid Slack signature' });
  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get('payload'));
  if (payload.type !== 'view_submission' || payload.view.callback_id !== 'guest_registration') return res.status(200).end();
  const v = payload.view.state.values;
  const office      = v.office.office_select.selected_option.value;
  const guestName   = v.guest_name.guest_name_input.value;
  const visitDate   = v.visit_date.visit_date_picker.selected_date;
  const visitTime   = v.visit_time.visit_time_picker.selected_time;
  const meetingRoom = v.meeting_room.meeting_room_input.value;
  const host        = v.host.host_input.value;
  const guestEmail  = v.guest_email.guest_email_input?.value ?? null;
  const notes       = v.notes.notes_input?.value ?? null;
  const dbId = OFFICE_DB[office];
  if (!dbId) return res.status(200).json({ response_action: 'errors', errors: { office: 'This office is not configured yet.' } });
  try {
    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        'Guest Name': { title: [{ text: { content: guestName } }] },
        'Visit Date': { date: { start: visitDate } },
        'Time': { rich_text: [{ text: { content: visitTime } }] },
        'Meeting Room': { rich_text: [{ text: { content: meetingRoom } }] },
        'Host': { rich_text: [{ text: { content: host } }] },
        ...(guestEmail && { 'Guest Email for Parkday Pass': { email: guestEmail } }),
        ...(notes && { 'Notes': { rich_text: [{ text: { content: notes } }] } }),
      },
    });
  } catch (err) {
    console.error('Notion API error:', err);
    return res.status(200).json({ response_action: 'errors', errors: { guest_name: 'Something went wrong saving to Notion. Check server logs.' } });
  }
  res.status(200).json({ response_action: 'clear' });
};
