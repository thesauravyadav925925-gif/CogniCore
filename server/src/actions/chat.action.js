/**
 * Chat -> action proposals. "Send the management report to finance@corp.com" never
 * executes: it creates a PENDING request that a manager/admin must approve.
 */
const { ActionRegistry, EMAIL_RE } = require('./action.registry');
const { can } = require('../security/rbac');

function proposeFromChat({ question, user, datasetId }) {
  if (!can(user, 'action.propose')) return { answer: `Your role (${user.role}) is not allowed to propose actions. Ask an analyst or manager.`, denied: true };
  const emails = [...new Set((String(question).match(/[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/g) || []).map((e) => e.replace(/[.,;:!?]+$/, '').toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  const wantsReport = /\breport\b/i.test(question);
  if (!emails.length) {
    return { answer: 'I can prepare that, but I need a recipient. Please include an email address, e.g. "Send the management report to finance@yourcompany.com".', needsInput: true };
  }
  if (!datasetId) return { answer: 'Please select a dataset first so I know which data the report should cover.', needsInput: true };
  const fmt = /\bdocx|word\b/i.test(question) ? 'docx' : /\bexcel|xlsx\b/i.test(question) ? 'xlsx' : 'pdf';
  const action = ActionRegistry.propose({
    type: 'send_email',
    params: { to: emails, subject: wantsReport ? 'CogniCore management report' : 'CogniCore update', body: 'Sent on request via CogniCore.', attach: wantsReport ? { datasetId, format: fmt } : null },
    requestedBy: user.user_id,
  });
  return {
    answer: `I've prepared this action but have NOT run it — it needs approval from a manager or admin first:\n• ${action.summary}\nReference: ${action.action_id} (status: pending). Open the Actions tab to review it.`,
    action,
  };
}

module.exports = { proposeFromChat };
