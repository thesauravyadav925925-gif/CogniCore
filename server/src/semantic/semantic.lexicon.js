/**
 * SEMANTIC LEXICON
 * Generic, language-level vocabulary (NOT domain rules) used only to attach a
 * human-readable *hint* to a column, e.g. "monetary value". It never changes
 * which SQL is generated or executed, and unknown names simply get no hint.
 * Everything here can be overridden per organisation via the knowledge base.
 */
const MONEY = /(salary|wage|pay|price|cost|amount|revenue|sales|income|fee|balance|expense|profit|budget|spend|charge|fare|tax|discount|payment|value|total)/i;
const PERCENT = /(pct|percent|percentage|rate|ratio|share|margin)/i;
const COUNTISH = /(count|qty|quantity|units|number_of|num_|n_|visits|orders|stock)/i;
const ID_NAME = /(^|_)(id|uuid|guid|key|code|no|number|num|ref)$/i;
const DATE_NAME = /(date|time|timestamp|_at$|^dob$|year|month|day)/i;
const NAME_LIKE = /(name|title|label|description|comment|notes?|address|city|email|phone)/i;

const BOOL_TRUE = new Set(['true', 'yes', 'y', '1', 't']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0', 'f']);

const PII_PATTERNS = [
  { kind: 'email', re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  { kind: 'phone', re: /^\+?[\d][\d\s\-().]{7,17}\d$/ },
  { kind: 'national_id', re: /^\d{3}-\d{2}-\d{4}$|^\d{4}\s\d{4}\s\d{4}$/ },
  { kind: 'card_number', re: /^(?:\d[ -]?){13,19}$/ },
];
const PII_NAME = { email: /e-?mail/i, phone: /(phone|mobile|contact_?no|tel)/i, national_id: /(ssn|aadhaar|aadhar|passport|national_?id|pan_?no)/i, card_number: /(card_?(no|number)|iban|account_?(no|number))/i };

module.exports = { MONEY, PERCENT, COUNTISH, ID_NAME, DATE_NAME, NAME_LIKE, BOOL_TRUE, BOOL_FALSE, PII_PATTERNS, PII_NAME };
