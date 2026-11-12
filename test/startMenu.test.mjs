// Pure start menu formatting. Transpiles the real StartMenu.ts; no DOM is constructed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/ui/StartMenu.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { formatLength, formatBest } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('route length is formatted from metres', () => {
  assert.equal(formatLength(2412), '2.41 KM');
  assert.equal(formatLength(850), '850 M');
  for (const bad of [NaN, Infinity, 0, -5]) assert.equal(formatLength(bad), '');
});

test('best lap is formatted only when supplied', () => {
  assert.equal(formatBest(83.456), 'PB 1:23.456');
  assert.equal(formatBest(5.2), 'PB 0:05.200');
  for (const none of [null, undefined, NaN, 0, -1]) assert.equal(formatBest(none), '');
});
