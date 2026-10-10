import test from 'node:test';
import assert from 'node:assert/strict';

import { SEED } from '../data/seed.js';
import { parseDashboard } from '../js/parse.js';

const known = { systems: SEED.qbank.systems, subjects: SEED.qbank.subjects };
const seedSystems = Object.fromEntries(SEED.qbank.systems.map((s) => [s.id, s.unused]));
const seedSubjects = Object.fromEntries(SEED.qbank.subjects.map((s) => [s.name, s.unused]));

const SEMICOLONS = `
Totals: all 3,654 · unused 3,255 · used 399 · correct 197 · incorrect 202 · marked 54 · omitted 0

Unused by system:
Allergy & Immunology 108; Biochemistry (General Principles) 65; Biostatistics & Epidemiology 120; Cardiovascular System 418; Dermatology 100; Ear, Nose & Throat 40; Endocrine, Diabetes & Metabolism 199; Female Reproductive System & Breast 79; Gastrointestinal & Nutrition 304; Genetics (General Principles) 62; Hematology & Oncology 231; Infectious Diseases 272; Male Reproductive System 52; Microbiology (General Principles) 30; Miscellaneous (Multisystem) 24; Nervous System 0; Ophthalmology 31; Pathology (General Principles) 39; Pharmacology (General Principles) 45; Poisoning & Environmental Exposure 32; Pregnancy, Childbirth & Puerperium 59; Psychiatric/Behavioral & Substance Use Disorder 179; Pulmonary & Critical Care 264; Renal, Urinary Systems & Electrolytes 226; Rheumatology/Orthopedics & Sports 168; Social Sciences (Ethics/Legal/Professional) 108.

Unused by subject (secondary tag, display only):
Anatomy 190; Behavioral science 251; Histology 25; Physiology 258; Pharmacology 495; Embryology 63; Genetics 98; Biostatistics 121; Immunology 132; Microbiology 323; Pathology 700; Pathophysiology 450; Biochemistry 149.
`;

test('reads the semicolon format, keeping systems and subjects apart', () => {
  const r = parseDashboard(SEMICOLONS, known);
  assert.deepEqual(r.systems, seedSystems);
  assert.deepEqual(r.subjects, seedSubjects);
  assert.deepEqual(r.totals, { all: 3654, unused: 3255, used: 399, correct: 197, incorrect: 202, marked: 54, omitted: 0 });
  assert.deepEqual(r.found, { systems: 26, subjects: 13, totals: 7 });
  assert.deepEqual(r.missingSystems, []);
  // The look-alikes that matter most.
  assert.equal(r.systems['pharmacology-gp'], 45);
  assert.equal(r.subjects.Pharmacology, 495);
  assert.equal(r.systems['allergy-immunology'], 108);
  assert.equal(r.subjects.Immunology, 132);
  assert.equal(r.systems['biostatistics-epidemiology'], 120);
  assert.equal(r.subjects.Biostatistics, 121);
});

test('reads one-per-line text with the number on the next line', () => {
  const text = SEED.qbank.systems.map((s) => `${s.name}\n${s.unused + 1}`).join('\n');
  const r = parseDashboard(text, known);
  assert.equal(r.found.systems, 26);
  assert.equal(r.systems.cardiovascular, 419);
  assert.equal(r.systems.nervous, 1);
  assert.deepEqual(r.subjects, {}, 'system lines are not mistaken for subjects');
  assert.deepEqual(r.totals, {});
});

test('reads dashboard-style totals and tolerant punctuation', () => {
  const r = parseDashboard(
    'Your Score\nTotal Correct: 1,197\nTotal Incorrect: 902\nTotal Omitted: 3\nQBank Usage\nUsed Questions 2,102\nUnused Questions 1,552\nTotal Questions 3,654',
    known,
  );
  assert.deepEqual(r.totals, { correct: 1197, incorrect: 902, omitted: 3, used: 2102, unused: 1552, all: 3654 });

  const loose = parseDashboard('CARDIOVASCULAR SYSTEM (318)\tRenal, Urinary Systems and Electrolytes = 200 | dermatology - 77', known);
  assert.deepEqual(loose.systems, { cardiovascular: 318, renal: 200, dermatology: 77 });
  assert.equal(loose.missingSystems.length, 23);
});

test('ignores percentages, partial words and text with nothing in it', () => {
  const r = parseDashboard('Cardiovascular System 62% correct. Overall 55. Unused 3,255. Reused 12. Dermatology 100 (25%)', known);
  assert.deepEqual(r.systems, { dermatology: 100 });
  assert.deepEqual(r.totals, { unused: 3255 }, '"Overall" is not "all" and "Reused" is not "used"');
  assert.deepEqual(parseDashboard('', known).found, { systems: 0, subjects: 0, totals: 0 });
  assert.deepEqual(parseDashboard(null, known).systems, {});
});
