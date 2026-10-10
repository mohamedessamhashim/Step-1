// Starting data for the planner. This is only the first-run copy: once the app
// has opened, the live data is in localStorage and every value here can be
// changed in Settings. "Reset to seed data" in Settings reloads this file.

const systems = [
  // [id, name, short name, unused questions, First Aid chapter id]
  ['allergy-immunology', 'Allergy & Immunology', 'Allergy & Immuno', 108, 'immunology'],
  ['biochemistry-gp', 'Biochemistry (General Principles)', 'Biochemistry', 65, 'biochemistry'],
  ['biostatistics-epidemiology', 'Biostatistics & Epidemiology', 'Biostats & Epi', 120, 'public-health'],
  ['cardiovascular', 'Cardiovascular System', 'Cardiovascular', 418, 'cardiovascular'],
  ['dermatology', 'Dermatology', 'Dermatology', 100, 'msk'],
  ['ent', 'Ear, Nose & Throat', 'ENT', 40, 'neuro'],
  ['endocrine', 'Endocrine, Diabetes & Metabolism', 'Endocrine', 199, 'endocrine'],
  ['female-repro', 'Female Reproductive System & Breast', 'Female Repro', 79, 'reproductive'],
  ['gastrointestinal', 'Gastrointestinal & Nutrition', 'GI & Nutrition', 304, 'gastrointestinal'],
  ['genetics-gp', 'Genetics (General Principles)', 'Genetics', 62, 'biochemistry'],
  ['heme-onc', 'Hematology & Oncology', 'Heme & Onc', 231, 'heme-onc'],
  ['infectious-diseases', 'Infectious Diseases', 'Infectious Dis.', 272, 'microbiology'],
  ['male-repro', 'Male Reproductive System', 'Male Repro', 52, 'reproductive'],
  ['microbiology-gp', 'Microbiology (General Principles)', 'Microbiology', 30, 'microbiology'],
  // No chapter: these only ever appear in random blocks.
  ['multisystem', 'Miscellaneous (Multisystem)', 'Multisystem', 24, null],
  // Already finished in the qbank. First Aid neuro is still scheduled.
  ['nervous', 'Nervous System', 'Nervous System', 0, 'neuro'],
  ['ophthalmology', 'Ophthalmology', 'Ophthalmology', 31, 'neuro'],
  ['pathology-gp', 'Pathology (General Principles)', 'Pathology', 39, 'pathology'],
  ['pharmacology-gp', 'Pharmacology (General Principles)', 'Pharmacology', 45, 'pharmacology'],
  ['poisoning', 'Poisoning & Environmental Exposure', 'Poisoning & Env.', 32, 'pharmacology'],
  ['pregnancy', 'Pregnancy, Childbirth & Puerperium', 'Pregnancy', 59, 'reproductive'],
  ['psychiatry', 'Psychiatric/Behavioral & Substance Use Disorder', 'Psychiatry', 179, 'psychiatry'],
  ['pulmonary', 'Pulmonary & Critical Care', 'Pulmonary', 264, 'respiratory'],
  ['renal', 'Renal, Urinary Systems & Electrolytes', 'Renal', 226, 'renal'],
  ['rheumatology', 'Rheumatology/Orthopedics & Sports', 'Rheum & Ortho', 168, 'msk'],
  ['social-sciences', 'Social Sciences (Ethics/Legal/Professional)', 'Social Sciences', 108, 'public-health'],
];

// Secondary tag in the qbank. Shown for reference only; blocks are not planned by subject.
const subjects = [
  ['Anatomy', 190],
  ['Behavioral science', 251],
  ['Histology', 25],
  ['Physiology', 258],
  ['Pharmacology', 495],
  ['Embryology', 63],
  ['Genetics', 98],
  ['Biostatistics', 121],
  ['Immunology', 132],
  ['Microbiology', 323],
  ['Pathology', 700],
  ['Pathophysiology', 450],
  ['Biochemistry', 149],
];

// A chapter's end page is the next start page in the book minus 1, unless an
// end page is entered. Chapters with no page range yet are scheduled by time,
// using estHours one-hour sessions.
const chapters = [
  // [id, name, short name, section, start page, end page, estimated hours]
  ['approach', 'Approaching the Organ Systems', 'Approach', 'organ', 280, null, 1],
  ['cardiovascular', 'Cardiovascular', 'Cardiovascular', 'organ', 283, null, 4],
  ['endocrine', 'Endocrine', 'Endocrine', 'organ', 329, null, 3],
  ['gastrointestinal', 'Gastrointestinal', 'GI', 'organ', 363, null, 4],
  ['heme-onc', 'Hematology and Oncology', 'Heme/Onc', 'organ', 409, null, 4],
  ['msk', 'Musculoskeletal, Skin, and Connective Tissue', 'MSK & Skin', 'organ', 449, null, 4],
  ['neuro', 'Neurology and Special Senses', 'Neuro', 'organ', 499, null, 6],
  ['psychiatry', 'Psychiatry', 'Psychiatry', 'organ', 569, null, 2],
  ['renal', 'Renal', 'Renal', 'organ', 595, null, 3],
  ['reproductive', 'Reproductive', 'Reproductive', 'organ', 629, null, 4],
  ['respiratory', 'Respiratory', 'Respiratory', 'organ', 677, null, 3],
  ['biochemistry', 'Biochemistry', 'Biochemistry', 'general', null, null, 6],
  ['immunology', 'Immunology', 'Immunology', 'general', null, null, 3],
  ['microbiology', 'Microbiology', 'Microbiology', 'general', null, null, 8],
  ['pathology', 'Pathology', 'Pathology', 'general', null, null, 3],
  ['pharmacology', 'Pharmacology', 'Pharmacology', 'general', null, null, 3],
  ['public-health', 'Public Health Sciences', 'Public Health', 'general', null, null, 3],
];

const nbme = (n) => ({ id: `nbme${n}`, name: `NBME ${n}`, questions: 200, parts: 4, per: 50, partName: 'sections' });
const uwsa = (n) => ({ id: `uwsa${n}`, name: `UWSA ${n}`, questions: 160, parts: 4, per: 40, partName: 'blocks' });

export const SEED = {
  settings: {
    startDate: '2026-10-11',
    examDate: '2026-12-28',
    dedicatedDays: 14,
    pace: {
      weekday: 40,
      weekend: 80,
      weekendFrom: '2026-10-17', // weekend days before this use the weekday pace
      dedicated: 100,
      blockMax: 40,
    },
    caps: { weekday: 60, weekend: 100 },
    sa: {
      workingCount: 5, // how many of the ordered list fall on working-phase Saturdays
      startFraction: 0.4, // first one lands near this share of the unused questions
      spacing: 3, // days apart in dedicated
      lastGap: 2, // last one this many days before the exam
    },
    fa: {
      pagesPerHour: null, // null = derive it so every chapter finishes before dedicated
      onSaDays: true,
    },
    randomAfterSa1: true,
    anki: true, // "Anki reviews" as the first task of every study day; fine to skip
    reviewMinutes: 20,
    goalPct: null,
    daysOff: {}, // { 'YYYY-MM-DD': 'label' }
    extras: {}, // { 'YYYY-MM-DD': extra questions added by a rebalance }
  },
  qbank: {
    totals: { all: 3654, unused: 3255, used: 399, correct: 197, incorrect: 202, marked: 54, omitted: 0 },
    systems: systems.map(([id, name, short, unused, chapter]) => ({ id, name, short, unused, chapter })),
    subjects: subjects.map(([name, unused]) => ({ name, unused })),
  },
  firstAid: {
    chapters: chapters.map(([id, name, short, section, start, end, estHours]) => ({ id, name, short, section, start, end, estHours })),
    // Walk order: organ systems in book order, then General Principles.
    order: chapters.map(([id]) => id),
  },
  assessments: {
    items: [nbme(28), nbme(29), nbme(30), nbme(31), nbme(32), nbme(33), nbme(34), uwsa(1), uwsa(2), uwsa(3)],
    // The first five are the working-phase Saturdays; the rest fall in dedicated.
    order: ['nbme28', 'nbme29', 'nbme30', 'nbme31', 'uwsa1', 'nbme32', 'uwsa2', 'nbme33', 'uwsa3', 'nbme34'],
  },
};
