// lib/form.js — shared modal definition for /guest (used by api/guest.js and api/interactions.js)
const OFFICES = {
  nyc:    { text: 'NYC 🗽',    value: 'nyc' },
  london: { text: 'London 🇬🇧', value: 'london' },
};
const GUEST_TYPES = ['Partner', 'Candidate', 'Customer', 'Personal', 'Vendor', 'Clay Employee'];
const INSTRUCTIONS = ['Will collect guest from downstairs', 'Guest can be let up by security', 'Dropping off Food and collecting'];

const pt = text => ({ type: 'plain_text', text });
const opt = (text, value = text) => ({ text: pt(text), value });
const input = (block_id, label, element, optional = false) => ({ type: 'input', block_id, label: pt(label), element, ...(optional && { optional: true }) });

function buildView(office = 'nyc', userId) {
  const common = [
    { type: 'input', block_id: 'office', dispatch_action: true, label: pt('Office'), element: {
        type: 'static_select', action_id: 'office_select', placeholder: pt('Select an office'),
        initial_option: opt(OFFICES[office].text, office),
        options: Object.values(OFFICES).map(o => opt(o.text, o.value)),
    } },
    input('guest_name',   'Guest Name(s)', { type: 'plain_text_input', action_id: 'guest_name_input', placeholder: pt('e.g. Jane Smith, John Doe') }),
    input('visit_date',   'Visit Date',    { type: 'datepicker', action_id: 'visit_date_picker' }),
    input('visit_time',   'Arrival Time',  { type: 'timepicker', action_id: 'visit_time_picker' }),
    input('meeting_room', 'Meeting Room',  { type: 'plain_text_input', action_id: 'meeting_room_input' }),
    input('host',         'Host',          { type: 'users_select', action_id: 'host_select', placeholder: pt('Select the Clay host'), ...(userId && { initial_user: userId }) }),
  ];
  const nyc = [
    input('guest_email', 'Guest Email',  { type: 'email_text_input', action_id: 'guest_email_input', placeholder: pt('e.g. jane@company.com') }),
    input('parkday',     'Parkday Pass', { type: 'checkboxes', action_id: 'parkday_check', options: [opt('Guest needs a Parkday Pass', 'yes')] }, true),
  ];
  const london = [
    input('guest_type',   'Guest Type',   { type: 'static_select', action_id: 'guest_type_select', placeholder: pt('Select a guest type'), options: GUEST_TYPES.map(t => opt(t)) }),
    input('instructions', 'Instructions', { type: 'static_select', action_id: 'instructions_select', placeholder: pt('Select security instructions'), options: INSTRUCTIONS.map(t => opt(t)) }),
    input('deliveroo',    'Deliveroo Voucher', { type: 'checkboxes', action_id: 'deliveroo_check', options: [opt('Guest needs a Deliveroo voucher', 'yes')] }, true),
    input('guest_email',  'Guest Email',  { type: 'email_text_input', action_id: 'guest_email_input', placeholder: pt('Required for a Deliveroo voucher') }, true),
  ];
  const notes = [
    input('notes', 'Notes', { type: 'plain_text_input', action_id: 'notes_input', multiline: true, placeholder: pt('Optional') }, true),
  ];
  return {
    type: 'modal',
    callback_id: 'guest_registration',
    private_metadata: JSON.stringify({ office }),
    title: pt('Register a Guest'),
    submit: pt('Register'),
    close: pt('Cancel'),
    blocks: [...common, ...(office === 'london' ? london : nyc), ...notes],
  };
}

module.exports = { buildView, OFFICES };
