// node tools/check-lang.mjs
// Fails if a Cantonese string has English words (other than brand names / units below),
// if an English string has Chinese characters, if the two files don't have the same keys,
// or if a Cantonese string uses a word from the app's "avoid" lists (Mainland / Taiwan wording).
import en from "../app/js/strings-en.js";
import zh from "../app/js/strings-zh-hk.js";
import { readFileSync, existsSync } from "node:fs";

// Brand names and units allowed inside Cantonese text. Longest first.
const ALLOW_PHRASES = ["Apple Intelligence", "Open Charge Map", "OpenStreetMap", "Apple ID", "JUICE", "Tesla", "iCloud",
  "iPhone", "Mac", "Google", "Outlook", "Nominatim", "OSRM", "Plus", "Pro", "CSV", "kWh", "kW", "km", "HK$", "°C"];
const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;

const problems = [];
const strings = o => Object.entries(o).filter(([k]) => !k.startsWith("_"))
  .flatMap(([k, v]) => Array.isArray(v) ? v.map((x, i) => [`${k}[${i}]`, x]) : [[k, v]]);

for (const [k, v] of strings(en)) if (CJK.test(v)) problems.push(`en.${k} has Chinese: ${v}`);
for (const [k, v] of strings(zh)) {
  let s = String(v).replace(/\{\d+\}/g, "");
  for (const p of ALLOW_PHRASES) s = s.split(p).join(" ");
  const words = s.match(/[A-Za-z]+/g);
  if (words) problems.push(`zh.${k} has English: ${words.join(" ")}  ←  ${v}`);
}

const ek = Object.keys(en).sort().join(), zk = Object.keys(zh).sort().join();
if (ek !== zk) {
  const a = new Set(Object.keys(en)), b = new Set(Object.keys(zh));
  for (const k of a) if (!b.has(k)) problems.push(`zh is missing ${k}`);
  for (const k of b) if (!a.has(k)) problems.push(`en is missing ${k}`);
}

// The app's Cantonese avoid lists, when this checkout sits next to the app (optional).
const ref = process.env.CANTO_REF || "/Users/hunterdavis/Desktop/Claude Code/Juice/docs/cantonese-reference";
for (const f of ["avoid-general.tsv", "avoid-driving.tsv"]) {
  const p = `${ref}/${f}`;
  if (!existsSync(p)) continue;
  const rows = readFileSync(p, "utf8").split("\n").slice(1).map(l => l.split("\t")).filter(r => r[0]);
  for (const [k, v] of strings(zh)) for (const [bad, good] of rows) if (String(v).includes(bad)) problems.push(`zh.${k} uses ${bad} (say ${good})`);
}

if (problems.length) { console.error(problems.join("\n")); console.error(`\n✗ ${problems.length} language problem(s)`); process.exit(1); }
console.log(`✓ languages separate: ${strings(en).length} English and ${strings(zh).length} Cantonese strings checked`);
