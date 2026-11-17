// api/guest.js — opens the /guest modal
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const { buildView } = require('../lib/form');
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
  await slack.views.open({ trigger_id: params.get('trigger_id'), view: buildView('nyc', params.get('user_id')) });
  res.status(200).end();
};
