#!/usr/bin/env node
/**
 * Generates the five demo datasets used to prove CogniCore is domain-agnostic
 * (Feature 21). Deterministic (seeded) so tests and demos are reproducible.
 * Each file deliberately contains realistic flaws (a planted outlier, a duplicate row,
 * inconsistent category spelling, missing values) so the quality/anomaly features have
 * something real to find.
 *   node server/scripts/generate-sample-data.js
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'sample-data');
fs.mkdirSync(OUT, { recursive: true });

let seed = 20260101;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (n) => String(n).padStart(2, '0');
const date = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const csv = (cols, rows) => [cols.join(','), ...rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n') + '\n';
const names = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Sneha', 'Vikram', 'Ananya', 'Ishaan', 'Priya', 'Arjun', 'Kavya', 'Nikhil', 'Pooja', 'Rahul', 'Sana', 'Tarun', 'Uma'];
const surnames = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Das', 'Patel', 'Singh', 'Menon', 'Gupta', 'Rao'];
const fullName = () => `${pick(names)} ${pick(surnames)}`;

// 1. Healthcare
{
  const depts = ['Cardiology', 'Orthopedics', 'Neurology', 'Pediatrics'];
  const docs = { Cardiology: ['Dr. Rao', 'Dr. Iyer'], Orthopedics: ['Dr. Khan', 'Dr. Menon'], Neurology: ['Dr. Das'], Pediatrics: ['Dr. Nair', 'Dr. Sen'] };
  const rows = [];
  for (let i = 1; i <= 240; i++) {
    const d = pick(depts); const m = int(1, 8); const day = int(1, 28);
    let status = pick(['Completed', 'Completed', 'Completed', 'Completed', 'Cancelled', 'No-show']);
    if (i % 53 === 0) status = status.toLowerCase();                      // inconsistent spelling
    const dt = i % 61 === 0 ? `${pad(day)}/${pad(m)}/2026` : date(2026, m, day); // mixed date format
    rows.push([i, fullName(), pick(docs[d]), d, status, status.toLowerCase() === 'cancelled' ? 0 : 500 + int(0, 30) * 25 + (d === 'Cardiology' ? 400 : 0), `patient${i}@mail.com`, i % 47 === 0 ? '' : dt]);
  }
  rows[10][5] = 95000;                                                      // outlier fee
  csv.dup = rows[3].slice(); rows.push(rows[3].slice());                    // exact duplicate row
  fs.writeFileSync(path.join(OUT, 'hospital_appointments.csv'), csv(['appt_id', 'patient_name', 'doctor', 'department', 'status', 'fee', 'contact_email', 'visit_date'], rows));
}

// 2. HR
{
  const depts = { Engineering: [60000, 120000], Sales: [35000, 80000], HR: [30000, 65000], Finance: [40000, 90000], Support: [25000, 50000] };
  const rows = [];
  for (let i = 1; i <= 160; i++) {
    const d = pick(Object.keys(depts)); const [lo, hi] = depts[d];
    rows.push([1000 + i, fullName(), d, pick(['Associate', 'Senior', 'Lead', 'Manager']), int(lo, hi), date(int(2018, 2025), int(1, 12), int(1, 28)), pick(['Active', 'Active', 'Active', 'Active', 'Resigned', 'On Leave'])]);
  }
  rows[7][4] = 9800000;                                                     // salary typo outlier
  rows[20][4] = '';                                                         // missing salary
  fs.writeFileSync(path.join(OUT, 'hr_employees.csv'), csv(['employee_id', 'employee_name', 'department', 'designation', 'salary', 'joining_date', 'status'], rows));
}

// 3. Finance
{
  const cats = { Rent: [18000, 22000], Payroll: [150000, 190000], Marketing: [20000, 45000], Software: [8000, 16000], Travel: [3000, 15000] };
  const rows = []; let id = 1;
  for (let m = 1; m <= 12; m++) for (const c of Object.keys(cats)) for (let k = 0; k < 3; k++) {
    const [lo, hi] = cats[c];
    rows.push([id++, c, int(lo, hi) * (1 + m * 0.01), date(2025, m, int(1, 28)), pick(['Paid', 'Paid', 'Paid', 'Pending'])]);
  }
  rows.push([id++, 'Marketing', 1250000, date(2025, 6, 15), 'Paid']);       // suspicious spend
  rows.push(rows[5].slice());                                               // duplicate row
  fs.writeFileSync(path.join(OUT, 'finance_expenses.csv'), csv(['txn_id', 'category', 'amount', 'txn_date', 'status'], rows.map((r) => [r[0], r[1], Math.round(r[2]), r[3], r[4]])));
}

// 4. Retail (flat)
{
  const prod = { Electronics: [8000, 60000], Clothing: [500, 4000], Groceries: [100, 1500], Furniture: [5000, 30000] };
  const regions = ['North', 'South', 'East', 'West'];
  const rows = []; let id = 1;
  for (let m = 1; m <= 12; m++) for (let k = 0; k < 18; k++) {
    const c = pick(Object.keys(prod)); const [lo, hi] = prod[c]; const u = int(1, 5);
    rows.push([id++, fullName(), c, u, Math.round(int(lo, hi) * u * (1 + m * 0.02)), date(2026, m, int(1, 28)), pick(regions)]);
  }
  fs.writeFileSync(path.join(OUT, 'retail_orders.csv'), csv(['order_id', 'customer_name', 'product_category', 'units', 'revenue', 'order_date', 'region'], rows));
}

// 5. Education
{
  const courses = ['Mathematics', 'Physics', 'Computer Science', 'Chemistry'];
  const rows = [];
  for (let i = 1; i <= 180; i++) {
    const att = int(55, 100);
    rows.push([5000 + i, fullName(), pick(courses), pick(['Sem 1', 'Sem 2', 'Sem 3']), Math.min(100, Math.max(0, Math.round(att * 0.55 + int(10, 45)))), att, date(int(2022, 2025), int(6, 8), int(1, 28))]);
  }
  fs.writeFileSync(path.join(OUT, 'education_students.csv'), csv(['student_id', 'student_name', 'course', 'semester', 'score', 'attendance_pct', 'enrolled_date'], rows));
}

// 6. Multi-table retail database (declared foreign keys) - for multi-table reasoning demos.
{
  const Database = require('better-sqlite3');
  const file = path.join(OUT, 'retail_multitable.db');
  try { fs.rmSync(file); } catch (_) { /* none */ }
  const db = new Database(file);
  db.exec(`
    CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT, city TEXT);
    CREATE TABLE products (product_id INTEGER PRIMARY KEY, product_name TEXT, category TEXT, unit_price REAL);
    CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id), order_date TEXT, status TEXT);
    CREATE TABLE order_items (item_id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(order_id), product_id INTEGER REFERENCES products(product_id), quantity INTEGER);
    CREATE TABLE payments (payment_id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(order_id), amount REAL, method TEXT);
  `);
  const cities = ['Chennai', 'Coimbatore', 'Madurai', 'Salem'];
  const ci = db.prepare('INSERT INTO customers VALUES (?,?,?)'); for (let i = 1; i <= 40; i++) ci.run(i, fullName(), pick(cities));
  const cats = ['Electronics', 'Clothing', 'Groceries', 'Furniture'];
  const pi = db.prepare('INSERT INTO products VALUES (?,?,?,?)'); for (let i = 1; i <= 24; i++) { const c = cats[i % 4]; pi.run(i, `${c} item ${i}`, c, 100 + i * 150); }
  const oi = db.prepare('INSERT INTO orders VALUES (?,?,?,?)'); const ii = db.prepare('INSERT INTO order_items VALUES (?,?,?,?)'); const pay = db.prepare('INSERT INTO payments VALUES (?,?,?,?)');
  let item = 1;
  for (let o = 1; o <= 150; o++) {
    oi.run(o, int(1, 40), date(2026, int(1, 9), int(1, 28)), pick(['Delivered', 'Delivered', 'Delivered', 'Cancelled']));
    let total = 0;
    for (let k = 0; k < int(1, 3); k++) { const p = int(1, 24); const q = int(1, 4); ii.run(item++, o, p, q); total += (100 + p * 150) * q; }
    pay.run(o, o, total, pick(['UPI', 'Card', 'Cash']));
  }
  db.close();
}
console.log('Sample datasets written to', OUT);
