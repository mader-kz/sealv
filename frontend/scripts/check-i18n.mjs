#!/usr/bin/env node
/* i18n parity checker. The dictionary is JSON precisely so this script can
   read it as data: the key sets of kk/ru/en must be identical, no value may
   be empty, and {placeholders} must match across languages — a Kazakh string
   that lost its {n} would silently print a number-less sentence. Exit 1 on
   any drift, so CI (and the pre-ship checklist) catches it. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dictPath = path.join(here, "..", "lib", "i18n.dict.json");
const dict = JSON.parse(readFileSync(dictPath, "utf8"));

let fail = false;
const err = (msg) => { console.error(`i18n: ${msg}`); fail = true; };

const langs = Object.keys(dict);
for (const required of ["kk", "ru", "en"]) {
  if (!langs.includes(required)) err(`language "${required}" is missing from the dictionary`);
}

const REF = "en";
const refKeys = Object.keys(dict[REF] ?? {});

for (const lang of langs) {
  const table = dict[lang];
  const missing = refKeys.filter((k) => !(k in table));
  const extra = Object.keys(table).filter((k) => !(k in dict[REF]));
  if (missing.length) err(`${lang}: missing ${missing.length} key(s): ${missing.join(", ")}`);
  if (extra.length) err(`${lang}: extra ${extra.length} key(s): ${extra.join(", ")}`);
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== "string" || v.trim() === "") err(`${lang}.${k}: empty or non-string value`);
  }
}

// {placeholder} parity against English
const varsOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const k of refKeys) {
  const ref = varsOf(dict[REF][k]);
  for (const lang of langs) {
    if (!(k in dict[lang])) continue;
    const got = varsOf(dict[lang][k]);
    if (got !== ref) err(`${k}: placeholder mismatch — en{${ref}} vs ${lang}{${got}}`);
  }
}

if (fail) process.exit(1);
console.log(`i18n OK: ${langs.length} languages × ${refKeys.length} keys, placeholders consistent`);
