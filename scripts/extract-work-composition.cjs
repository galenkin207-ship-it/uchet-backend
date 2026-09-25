const XLSX = require('xlsx');
const fs = require('fs');

const wb = XLSX.readFile('/home/galen/uchet-backend/scripts/data/svod-catalog-raw.xlsx');
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0, defval: '' });

const data = rows.slice(1);
const result = [];

for (const r of data) {
  const sbornikCode = String(r[1]).trim();
  const leafCode = String(r[0]).trim();
  const composition = String(r[16]).trim();
  if (!sbornikCode || !leafCode || !composition) continue;
  result.push({ sbornik_code: sbornikCode, leaf_code: leafCode, work_composition: composition });
}

fs.writeFileSync(
  '/home/galen/uchet-backend/scripts/data/work_composition.json',
  JSON.stringify(result, null, 0)
);

console.log('Записей с составом работ:', result.length);
console.log('Пример первой записи:', result[0]);
