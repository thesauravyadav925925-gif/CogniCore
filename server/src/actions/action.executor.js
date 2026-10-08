const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const { ActionRegistry } = require('./action.registry');
const { DatasetRegistry } = require('../ingestion/dataset.registry');
const { AuthRegistry } = require('../security/auth.registry');
const { resolvePolicy } = require('../security/data.policy');
const { canRead, can } = require('../security/rbac');
const { buildManagementReport } = require('../report/report.builder');
const exporters = require('../report/report.exporters');

const EXPORT_DIR = path.join(config.paths.data, 'exports');

async function makeReportBuffer({ datasetId, format, proposer }) {
  const dataset = DatasetRegistry.get(datasetId);
  if (!dataset) throw new Error(`Dataset "${datasetId}" not found.`);
  if (!canRead(proposer, dataset)) throw new Error('The requester no longer has access to this dataset.');
  if (!can(proposer, 'report')) throw new Error(`The requester's role (${proposer.role}) cannot generate reports.`);
  const policy = resolvePolicy({ datasetId, user: proposer });
  const report = await buildManagementReport({ dataset, policy });
  const buf = format === 'docx' ? exporters.toDocx(report) : format === 'xlsx' ? exporters.toXlsx(report) : await exporters.toPdf(report);
  return { buf, name: `${dataset.name.replace(/[^A-Za-z0-9_-]/g, '_')}-management-report.${format}`, report };
}

async function sendSmtp(mail) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { return null; }
  if (!process.env.SMTP_HOST) return null;
  const tx = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587', 10), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
  await tx.sendMail(mail);
  return 'smtp';
}

const EXECUTORS = {
  async send_email(action, proposer) {
    const p = action.params;
    let attachment = null;
    if (p.attach) {
      const r = await makeReportBuffer({ datasetId: p.attach.datasetId, format: p.attach.format, proposer });
      attachment = { filename: r.name, content: r.buf };
    }
    const mail = { from: process.env.SMTP_FROM || 'cognicore@localhost', to: p.to.join(', '), subject: p.subject, text: p.body, attachments: attachment ? [attachment] : [] };
    let delivery = await sendSmtp(mail);
    if (!delivery) {
      delivery = 'simulated'; // no SMTP configured: recorded in the outbox so the workflow is demonstrable and honest
      if (attachment) { fs.mkdirSync(EXPORT_DIR, { recursive: true }); fs.writeFileSync(path.join(EXPORT_DIR, `${action.action_id}-${attachment.filename}`), attachment.content); }
    }
    for (const to of p.to) ActionRegistry.recordOutbox({ actionId: action.action_id, to, subject: p.subject, body: p.body, attachmentName: attachment?.filename, delivery });
    return { delivery, recipients: p.to, attachment: attachment?.filename || null, note: delivery === 'simulated' ? 'SMTP is not configured; the email was recorded in the outbox instead of being delivered.' : 'Delivered via SMTP.' };
  },
  async save_report(action, proposer) {
    const r = await makeReportBuffer({ datasetId: action.params.datasetId, format: action.params.format, proposer });
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const file = path.join(EXPORT_DIR, `${action.action_id}-${r.name}`);
    fs.writeFileSync(file, r.buf);
    return { file: path.basename(file), bytes: r.buf.length };
  },
  async webhook(action) {
    const res = await fetch(action.params.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action.params.payload), redirect: 'error', signal: AbortSignal.timeout(10000) });
    return { status: res.status, ok: res.ok };
  },
};

const selfApproval = () => process.env.ACTION_ALLOW_SELF_APPROVAL === 'true';

function assertCanDecide(action, decider) {
  if (!can(decider, 'action.approve')) throw Object.assign(new Error(`Your role (${decider.role}) cannot approve actions.`), { status: 403 });
  if (action.status !== 'pending') throw Object.assign(new Error(`This action is already ${action.status}.`), { status: 409 });
  if (action.requested_by === decider.user_id && decider.role !== 'admin' && !selfApproval()) {
    throw Object.assign(new Error('Actions must be approved by someone other than the requester.'), { status: 403 });
  }
}

async function approveAndExecute(actionId, decider, note = null) {
  const action = ActionRegistry.get(actionId);
  if (!action) throw Object.assign(new Error('Action not found.'), { status: 404 });
  assertCanDecide(action, decider);
  const proposerRow = AuthRegistry.getUserById(action.requested_by);
  if (!proposerRow) return ActionRegistry.markDecision(actionId, { status: 'failed', decidedBy: decider.user_id, note, result: { error: 'The requesting user no longer exists.' } });
  try {
    const result = await EXECUTORS[action.type](action, proposerRow);
    AuthRegistry.appendAudit({ userId: decider.user_id, action: 'action.executed', resourceType: 'action', resourceId: actionId, success: true, details: { type: action.type, requestedBy: action.requested_by } });
    return ActionRegistry.markDecision(actionId, { status: 'executed', decidedBy: decider.user_id, note, result });
  } catch (err) {
    AuthRegistry.appendAudit({ userId: decider.user_id, action: 'action.executed', resourceType: 'action', resourceId: actionId, success: false, details: { type: action.type, error: err.message } });
    return ActionRegistry.markDecision(actionId, { status: 'failed', decidedBy: decider.user_id, note, result: { error: err.message } });
  }
}

function reject(actionId, decider, note = null) {
  const action = ActionRegistry.get(actionId);
  if (!action) throw Object.assign(new Error('Action not found.'), { status: 404 });
  assertCanDecide(action, decider);
  AuthRegistry.appendAudit({ userId: decider.user_id, action: 'action.rejected', resourceType: 'action', resourceId: actionId, success: true, details: { type: action.type } });
  return ActionRegistry.markDecision(actionId, { status: 'rejected', decidedBy: decider.user_id, note });
}

module.exports = { approveAndExecute, reject, assertCanDecide, makeReportBuffer };
