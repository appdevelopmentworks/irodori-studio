#!/usr/bin/env node
// Translation check for the UI (D17, golden rule 6). Exits 1 on any of:
//   - a required locale directory, or a feature file, missing in some locale
//   - a locale file that src/i18n/resources.ts does not register
//   - keys missing from / extra in a locale compared with the source locale (ja);
//     plural keys (`_one`, `_other`, ...) are compared per locale via Intl.PluralRules
//   - empty or non-string values, a UTF-8 BOM, or {{variables}} that differ from ja
//   - keys used in code but absent from ja, and ja keys never referenced in code
//
// Code is parsed with the TypeScript compiler API, so keys that only appear in
// comments do not count as used. A key counts as used when it is the literal first
// argument of `t()` / `i18n.t()`, an `i18nKey` prop, or any other string literal
// equal to a key (e.g. an error-code -> key map). A template literal argument such
// as t(`emoji.${id}`) marks every key under its static prefix as used.
//
// Usage: node scripts/check-i18n.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'src');
const LOCALES_DIR = join(SRC_DIR, 'i18n', 'locales');
const RESOURCES_FILE = join(SRC_DIR, 'i18n', 'resources.ts');

const SOURCE_LOCALE = 'ja';
const REQUIRED_LOCALES = ['ja', 'en', 'zh-Hans', 'de'];
const PLURAL_RE = /^(.+)_(zero|one|two|few|many|other)$/;
const VARIABLE_RE = /\{\{\s*([^,}\s]+)[^}]*\}\}/g;

const errors = [];
const fail = (message) => errors.push(message);
const rel = (path) => relative(ROOT, path).split('\\').join('/');

// ---------------------------------------------------------------------------
// Locale resources
// ---------------------------------------------------------------------------

function flatten(value, prefix, out, file) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [segment, child] of Object.entries(value)) {
      if (segment.includes('.')) fail(`${file}: key segment "${segment}" must not contain "."`);
      flatten(child, `${prefix}.${segment}`, out, file);
    }
    return;
  }
  if (typeof value !== 'string') {
    fail(`${file}: "${prefix}" must be a string`);
    return;
  }
  if (value.trim() === '') fail(`${file}: "${prefix}" is empty`);
  out.set(prefix, value);
}

function loadLocale(locale) {
  const dir = join(LOCALES_DIR, locale);
  const files = readdirSync(dir).filter((name) => extname(name) === '.json').sort();
  const strings = new Map();
  for (const name of files) {
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) {
      fail(`${rel(path)}: remove the UTF-8 BOM`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      fail(`${rel(path)}: invalid JSON (${err.message})`);
      continue;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      fail(`${rel(path)}: top level must be an object`);
      continue;
    }
    flatten(data, basename(name, '.json'), strings, rel(path));
  }
  return { files, strings };
}

/** Splits keys into plain keys and plural bases (`items_one` -> `items`: {one}). */
function groupKeys(strings) {
  const plain = new Set();
  const plurals = new Map();
  for (const key of strings.keys()) {
    const match = PLURAL_RE.exec(key);
    if (match) {
      const forms = plurals.get(match[1]) ?? new Set();
      forms.add(match[2]);
      plurals.set(match[1], forms);
    } else {
      plain.add(key);
    }
  }
  return { plain, plurals };
}

function variablesOf(texts) {
  const names = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(VARIABLE_RE)) names.add(match[1]);
  }
  return [...names].sort().join(', ');
}

function textsFor(strings, key, isPlural) {
  if (!isPlural) return [strings.get(key)];
  return [...strings.entries()]
    .filter(([candidate]) => PLURAL_RE.exec(candidate)?.[1] === key)
    .map(([, text]) => text);
}

const missingLocales = REQUIRED_LOCALES.filter((locale) => !existsSync(join(LOCALES_DIR, locale)));
for (const locale of missingLocales) fail(`missing locale directory src/i18n/locales/${locale}`);
const extraLocales = existsSync(LOCALES_DIR)
  ? readdirSync(LOCALES_DIR).filter((name) => !REQUIRED_LOCALES.includes(name))
  : [];
for (const name of extraLocales) fail(`unexpected locale directory src/i18n/locales/${name}`);

if (missingLocales.includes(SOURCE_LOCALE)) {
  report();
}

const locales = new Map(
  REQUIRED_LOCALES.filter((locale) => !missingLocales.includes(locale)).map((locale) => [
    locale,
    loadLocale(locale),
  ]),
);
const source = locales.get(SOURCE_LOCALE);
const sourceGroups = groupKeys(source.strings);

// Every locale file must be registered in resources.ts, or its keys never load.
const resourcesText = readFileSync(RESOURCES_FILE, 'utf8');
for (const [locale, { files }] of locales) {
  for (const name of files) {
    if (!resourcesText.includes(`./locales/${locale}/${name}`)) {
      fail(`src/i18n/locales/${locale}/${name} is not registered in src/i18n/resources.ts`);
    }
  }
}

for (const [locale, { files, strings }] of locales) {
  if (locale === SOURCE_LOCALE) continue;
  const dir = `src/i18n/locales/${locale}`;

  for (const name of source.files) {
    if (!files.includes(name)) fail(`${dir}/${name} is missing (exists in ${SOURCE_LOCALE})`);
  }
  for (const name of files) {
    if (!source.files.includes(name)) fail(`${dir}/${name} has no ${SOURCE_LOCALE} counterpart`);
  }

  const groups = groupKeys(strings);
  for (const key of sourceGroups.plain) {
    if (!groups.plain.has(key)) fail(`${locale}: missing key "${key}"`);
  }
  for (const key of groups.plain) {
    if (!sourceGroups.plain.has(key)) fail(`${locale}: key "${key}" does not exist in ${SOURCE_LOCALE}`);
  }

  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const base of sourceGroups.plurals.keys()) {
    if (!groups.plurals.has(base)) fail(`${locale}: missing plural key "${base}_*"`);
  }
  for (const [base, forms] of groups.plurals) {
    if (!sourceGroups.plurals.has(base)) {
      fail(`${locale}: plural key "${base}_*" does not exist in ${SOURCE_LOCALE}`);
      continue;
    }
    for (const category of categories) {
      if (!forms.has(category)) fail(`${locale}: missing plural form "${base}_${category}"`);
    }
    for (const form of forms) {
      // i18next resolves `_zero` for count === 0 in every language.
      if (form !== 'zero' && !categories.includes(form)) {
        fail(`${locale}: "${base}_${form}" is not a plural category of ${locale}`);
      }
    }
  }

  const shared = [
    ...[...sourceGroups.plain].filter((key) => groups.plain.has(key)).map((key) => [key, false]),
    ...[...sourceGroups.plurals.keys()]
      .filter((base) => groups.plurals.has(base))
      .map((base) => [base, true]),
  ];
  for (const [key, isPlural] of shared) {
    const expected = variablesOf(textsFor(source.strings, key, isPlural));
    const actual = variablesOf(textsFor(strings, key, isPlural));
    if (expected !== actual) {
      fail(`${locale}: "${key}" uses variables {${actual}} but ${SOURCE_LOCALE} uses {${expected}}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Key usage in code
// ---------------------------------------------------------------------------

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== LOCALES_DIR) yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield path;
    }
  }
}

function isTranslateCallee(expression) {
  if (ts.isIdentifier(expression)) return expression.text === 't';
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 't';
  return false;
}

const explicitKeys = [];
const dynamicPrefixes = [];
const literals = new Set();

for (const path of sourceFiles(SRC_DIR)) {
  const text = readFileSync(path, 'utf8');
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const where = (node) =>
    `${rel(path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

  const recordKeyArgument = (argument) => {
    // Look through `('key')`, `'key' as X`, `'key' satisfies X`, `<X>'key'`.
    let node = argument;
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      node = node.expression;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      explicitKeys.push({ key: node.text, where: where(node) });
    } else if (ts.isTemplateExpression(node)) {
      dynamicPrefixes.push({ prefix: node.head.text, where: where(node) });
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.add(node.text);
    } else if (ts.isCallExpression(node) && isTranslateCallee(node.expression)) {
      if (node.arguments.length > 0) recordKeyArgument(node.arguments[0]);
    } else if (ts.isJsxAttribute(node) && node.name.getText(file) === 'i18nKey' && node.initializer) {
      const init = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (init) recordKeyArgument(init);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

const knownKeys = new Set([...sourceGroups.plain, ...sourceGroups.plurals.keys()]);
const used = new Set();

for (const { key, where } of explicitKeys) {
  if (knownKeys.has(key)) used.add(key);
  else fail(`${where}: key "${key}" does not exist in ${SOURCE_LOCALE}`);
}
for (const { prefix, where } of dynamicPrefixes) {
  const matches = [...knownKeys].filter((key) => key.startsWith(prefix));
  if (prefix === '' || matches.length === 0) {
    fail(`${where}: dynamic key prefix "${prefix}" matches no ${SOURCE_LOCALE} keys`);
  }
  if (prefix !== '') for (const key of matches) used.add(key);
}
for (const key of knownKeys) {
  if (literals.has(key)) used.add(key);
}
for (const key of [...knownKeys].sort()) {
  if (!used.has(key)) fail(`unused key "${key}" (not referenced in src/)`);
}

report();

function report() {
  if (errors.length > 0) {
    console.error(`check-i18n: ${errors.length} problem(s)`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exit(1);
  }
  const keyCount = source.strings.size;
  console.log(
    `check-i18n: OK — ${locales.size} locales (${[...locales.keys()].join(', ')}), ` +
      `${source.files.length} files, ${keyCount} keys, all used and translated`,
  );
  process.exit(0);
}
