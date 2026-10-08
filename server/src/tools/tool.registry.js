/**
 * TOOL REGISTRY
 * RULE: "Tools are controlled capabilities, not arbitrary code execution."
 *
 * This registry is descriptive, not a dispatcher that lets an LLM freely
 * invoke arbitrary tools. Every tool in CogniCore is only ever triggered
 * by an explicit person action (a button click in the UI, hitting a
 * specific REST endpoint) - that IS the "explicit confirmation" the spec
 * asks for. The registry exists so the API can advertise what's available
 * (GET /api/tools) and so future tools have one obvious place to be listed.
 */
const TOOLS = [
  {
    name: 'generate_chart',
    description: 'Build a bar/line/pie/scatter chart from a validated query result.',
    endpoint: 'POST /api/tools/chart',
    destructive: false,
  },
  {
    name: 'export_csv',
    description: 'Export a validated query result as a CSV file.',
    endpoint: 'POST /api/tools/export (format=csv)',
    destructive: false,
  },
  {
    name: 'export_excel',
    description: 'Export a validated query result as an Excel (.xlsx) file.',
    endpoint: 'POST /api/tools/export (format=xlsx)',
    destructive: false,
  },
  {
    name: 'generate_report',
    description: 'Build a PDF report bundling a question, its answer, the query, and the result table.',
    endpoint: 'POST /api/tools/report',
    destructive: false,
  },
  {
    name: 'calculate_metric',
    description: 'Compute a deterministic aggregate (sum/avg/min/max/count/median) over a column of a validated result.',
    endpoint: 'POST /api/tools/calculate',
    destructive: false,
  },
  // Future, per spec Section 22 - each would need explicit per-action
  // confirmation and permission checks before being added here:
  //   send_email, create_ticket, schedule_task, update_record
];

module.exports = { TOOLS };
