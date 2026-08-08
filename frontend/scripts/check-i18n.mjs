#!/usr/bin/env node
/* i18n parity checker. The dictionary is JSON precisely so this script can
   read it as data: the key sets of kk/ru/en must be identical, no value may
   be empty, and {placeholders} must match across languages — a Kazakh string
   that lost its {n} would silently print a number-less sentence. Exit 1 on
   any drift, so CI (and the pre-ship checklist) catches it.

   It also walks the source for t("…") call sites, because parity alone cannot
   see the two ways this dictionary has actually broken: a sweep deleted a key
   three components still called (they rendered the raw key string), and a
   reworded value took a {sortie} placeholder while its caller kept passing
   `region` (the token printed literally, in all three languages). Both are
   consistent across languages, so the parity pass was green for both. */
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/* Call sites. Every t("key") / translate(lang, "key") / plural(…, "key") in the
   app must resolve, and the vars a caller passes must be the vars the English
   string actually interpolates. Keys built at runtime (stage.${stage}) are not
   literals and are skipped by construction — stageText falls back visibly. */
const SRC_DIRS = ["app", "components", "lib", "store"];
const root = path.join(here, "..");
const sources = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "out") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs)$/.test(name)) sources.push(p);
  }
};
for (const d of SRC_DIRS) {
  const p = path.join(root, d);
  try { walk(p); } catch {}
}

// t("key") or t("key", { a: …, b }) — the object literal is scanned only for its
// top-level property names, which is all a placeholder check needs. Values may
// be calls or member chains, so the split tracks bracket depth rather than
// splitting on every comma, and shorthand ({ base }) counts as its own name.
const CALL = /\bt\(\s*"([\w.]+)"\s*(?:,\s*\{((?:[^{}]|\{[^{}]*\})*)\})?\s*\)/g;
const BARE = /\b(?:translate\([^,]+,|tp\([^,]+,|plural\([^,]+,[^,]+,)\s*"([\w.]+)"/g;

function propNames(args) {
  const out = [];
  let depth = 0;
  let part = "";
  const take = () => {
    const m = part.match(/^\s*(?:"([\w.]+)"|'([\w.]+)'|(\w+))\s*(:|$)/);
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
    part = "";
  };
  for (const ch of args) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { take(); continue; }
    part += ch;
  }
  take();
  return out.sort().join(",");
}
for (const file of sources) {
  const src = readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  for (const m of src.matchAll(CALL)) {
    const [, key, args] = m;
    if (!(key in dict[REF])) { err(`${rel}: t("${key}") is not in the dictionary`); continue; }
    const want = varsOf(dict[REF][key]);
    const got = args ? propNames(args) : "";
    if (got !== want) err(`${rel}: t("${key}") passes {${got}} but the string takes {${want}}`);
  }
  for (const m of src.matchAll(BARE)) {
    if (!(m[1] in dict[REF])) err(`${rel}: "${m[1]}" is not in the dictionary`);
  }
}

if (fail) process.exit(1);
console.log(
  `i18n OK: ${langs.length} languages × ${refKeys.length} keys, placeholders consistent, ` +
    `${sources.length} source files scanned`,
);
