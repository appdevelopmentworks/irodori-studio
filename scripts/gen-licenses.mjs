#!/usr/bin/env node
// Runs before `tauri build` bundles the app (tauri.conf.json > build.beforeBundleCommand),
// after the Rust build: writes resources/licenses/rust-crates.md, every crate compiled into
// this platform's app with its version, license and copyright lines, followed by the license
// files of the crates that do not offer MIT or Apache-2.0 and the texts of those two.
// THIRD_PARTY_NOTICES.md summarizes the list. Reads `cargo metadata --offline`, so it needs
// the crates the Rust build has just downloaded.
//
// Usage: node scripts/gen-licenses.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'resources', 'licenses', 'rust-crates.md');
const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice)/i;
const PLACEHOLDER = /\[yyyy\]|\{yyyy\}|<year>|\[name of copyright owner\]|<copyright holders?>/i;
// Crates offering one of these are used under it; its text is printed once at the end.
const COVERED = new Set(['MIT', 'Apache-2.0']);

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const run = (command, args) =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Splits an SPDX expression at the operator, outside parentheses. */
function splitTop(expression, operator) {
  const parts = [];
  let depth = 0;
  let current = [];
  for (const token of expression.split(/(\(|\)|\s+)/).filter((t) => t.trim())) {
    if (token === '(') depth += 1;
    if (token === ')') depth -= 1;
    if (token === operator && depth === 0) {
      parts.push(current.join(' '));
      current = [];
    } else {
      current.push(token);
    }
  }
  parts.push(current.join(' '));
  return parts;
}

/** Whether the expression lets the crate be used under MIT or Apache-2.0 alone. */
function offersCovered(expression) {
  const e = expression.replace(/\s*\/\s*/g, ' OR ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
  if (COVERED.has(e)) return true;
  const alternatives = splitTop(e, 'OR');
  if (alternatives.length > 1) return alternatives.some(offersCovered);
  const inner = e.slice(1, -1);
  if (e.startsWith('(') && e.endsWith(')') && splitTop(`(${inner})`, 'AND').length === 1) {
    return offersCovered(inner);
  }
  return false;
}

/** The crate's license files (also inside a LICENSES/ folder), as {name, text}. */
function licenseFiles(pkg) {
  const dir = dirname(pkg.manifest_path);
  const files = [];
  for (const name of readdirSync(dir).filter((n) => LICENSE_FILE.test(n)).sort()) {
    const path = join(dir, name);
    const names = statSync(path).isDirectory()
      ? readdirSync(path).sort().map((inner) => join(name, inner))
      : [name];
    for (const file of names) {
      if (statSync(join(dir, file)).isFile()) {
        files.push({ name: file.replaceAll('\\', '/'), text: readFileSync(join(dir, file), 'utf8') });
      }
    }
  }
  return files;
}

function copyrightLines(files) {
  const lines = new Set();
  for (const { text } of files) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      const isNotice = /copyright/i.test(line) && (/\(c\)|©/i.test(line) || /\b(19|20)\d{2}\b/.test(line));
      if (isNotice && !PLACEHOLDER.test(line) && line.length <= 200) lines.add(line);
    }
  }
  return [...lines];
}

const cell = (value) => value.replaceAll('|', '\\|');
const normalized = (text) => text.replace(/\s+/g, ' ').trim();

const host = /^host: (.+)$/m.exec(run('rustc', ['-vV']))[1].trim();
const metadata = JSON.parse(
  run('cargo', [
    'metadata',
    '--format-version',
    '1',
    '--offline',
    '--filter-platform',
    host,
    '--manifest-path',
    join(ROOT, 'src-tauri', 'Cargo.toml'),
  ]),
);

// Normal dependencies of the app, transitively: build scripts' and dev dependencies are not
// compiled into it.
const packages = new Map(metadata.packages.map((p) => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const root = metadata.resolve.root;
const reached = new Set([root]);
const queue = [root];
while (queue.length > 0) {
  for (const dep of nodes.get(queue.shift()).deps) {
    if (reached.has(dep.pkg) || !dep.dep_kinds.some((kind) => kind.kind === null)) continue;
    reached.add(dep.pkg);
    queue.push(dep.pkg);
  }
}
reached.delete(root);

const crates = [...reached]
  .map((id) => packages.get(id))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map((pkg) => {
    const files = licenseFiles(pkg);
    const license = pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'unspecified');
    return { pkg, files, license, covered: pkg.license != null && offersCovered(pkg.license) };
  });

const rows = crates.map(({ pkg, files, license }) => {
  const notices = copyrightLines(files);
  const authors = (pkg.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/g, '').trim()).filter(Boolean);
  const attribution =
    notices.length > 0
      ? notices.join('; ')
      : authors.length > 0
        ? `Authors: ${authors.join(', ')}`
        : `The ${pkg.name} authors${pkg.repository ? ` (${pkg.repository})` : ''}`;
  return `| ${cell(pkg.name)} | ${pkg.version} | ${cell(license)} | ${cell(attribution)} |`;
});

// The Apache License text, from the first crate that ships it.
const apache = crates
  .flatMap(({ files }) => files)
  .find(({ name, text }) => /apache/i.test(name) && text.includes('TERMS AND CONDITIONS FOR USE'));

const printed = new Map(); // normalized text -> where it was printed
if (apache) printed.set(normalized(apache.text), 'the Apache License 2.0 below');
printed.set(normalized(MIT_TEXT), 'the MIT License below');

const others = [];
for (const { pkg, files, license, covered } of crates) {
  if (covered) continue;
  others.push(`### ${pkg.name} ${pkg.version} (${license})`, '');
  if (files.length === 0) {
    others.push(
      `The crate ships no license file; the license text is at https://spdx.org/licenses/.`,
      '',
    );
  }
  for (const { name, text } of files) {
    const same = printed.get(normalized(text));
    if (same) {
      others.push(`\`${name}\`: the same text as ${same}.`, '');
      continue;
    }
    printed.set(normalized(text), `\`${name}\` of ${pkg.name} ${pkg.version}`);
    others.push(`\`${name}\`:`, '', '```text', text.replace(/\r\n/g, '\n').trimEnd(), '```', '');
  }
}

const byLicense = new Map();
for (const { license } of crates) byLicense.set(license, (byLicense.get(license) ?? 0) + 1);

const output = [
  `# Rust crates compiled into irodori-studio (${host})`,
  '',
  `Generated by \`scripts/gen-licenses.mjs\` from \`cargo metadata\` when this build was made: ${crates.length} crates, the normal dependencies of the app, transitively. Each is listed with its version, its license and the copyright lines of its license files (its authors when it has none). Crates that offer MIT or Apache-2.0 are used under that license; both texts are at the end. The license files of the other crates follow the table in full.`,
  '',
  '| Crate | Version | License | Copyright |',
  '| --- | --- | --- | --- |',
  ...rows,
  '',
  '## License files of crates under other licenses',
  '',
  ...others,
  '## MIT License',
  '',
  'Applies, with the copyright lines in the table, to the crates used under MIT.',
  '',
  '```text',
  MIT_TEXT,
  '```',
  '',
  '## Apache License 2.0',
  '',
  ...(apache
    ? ['```text', apache.text.replace(/\r\n/g, '\n').trimEnd(), '```']
    : ['The text is at https://www.apache.org/licenses/LICENSE-2.0.']),
  '',
].join('\n');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, output, 'utf8');
const summary = [...byLicense.entries()].sort((a, b) => b[1] - a[1]);
console.log(`gen-licenses: ${crates.length} crates (${host}) -> resources/licenses/rust-crates.md`);
for (const [license, count] of summary) console.log(`  ${String(count).padStart(4)}  ${license}`);
