// api/guest.js
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
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
  const trigger_id = params.get('trigger_id');
  await slack.views.open({
    trigger_id,
    view: {
      type: 'modal',
      callback_id: 'guest_registration',
      title: { type: 'plain_text', text: 'Register a Guest' },
      submit: { type: 'plain_text', text: 'Register' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'office', label: { type: 'plain_text', text: 'Office' }, element: { type: 'static_select', action_id: 'office_select', placeholder: { type: 'plain_text', text: 'Select an office' }, options: [ { text: { type: 'plain_text', text: 'NYC 🗽' }, value: 'nyc' }, { text:{ type: 'plain_text', text: 'SF 🌫️' }, value: 'sf' }, { text: { type: 'plain_text', text: 'London 🇬🇧' }, value: 'london' } ] } },
        { type: 'input', block_id: 'guest_name', label: { type: 'plain_text', text: 'Guest Name(s)' }, element: { type: 'plain_text_input', action_id: 'guest_name_input', placeholder: { type: 'plain_text', text: 'e.g. Jane Smith, John Doe' } } },
        { type: 'input', block_id: 'visit_date', label: { type: 'plain_text', text: 'Visit Date' }, element: { type: 'datepicker', action_id: 'visit_date_picker' } },
        { type: 'input', block_id: 'visit_time', label: { type: 'plain_text', text: 'Time' }, element: { type: 'timepicker', action_id: 'visit_time_picker' } },
        { type: 'input', block_id: 'meeting_room', label: { type: 'plain_text', text: 'Meeting Room' }, element: { type: 'plain_text_input', action_id: 'meeting_room_input' } },
        { type: 'input', block_id: 'host', label: { type: 'plain_text', text: 'Host' }, element: { type: 'plain_text_input', action_id: 'host_input' } },
        { type: 'input', block_id: 'guest_email', label: { type: 'plain_text', text: 'Guest Email (for Parkday Pass)' }, optional: true, element: { type: 'plain_text_input', action_id: 'guest_email_input', placeholder: { type: 'plain_text', text: 'Optional' } } },
        { type: 'input', block_id: 'notes', label: { type: 'plain_text', text: 'Notes' }, optional: true, element: { type: 'plain_text_input', action_id: 'notes_input', multiline: true, placeholder: { type: 'plain_text', text: 'Optional' } } }
      ]
    }
  });
  res.status(200).end();
};
