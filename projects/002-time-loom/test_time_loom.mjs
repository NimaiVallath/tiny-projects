import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyze, arcPath, render, toMinutes } from './time_loom.mjs';

const samplePath = fileURLToPath(new URL('./examples/sample-day.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('./time_loom.mjs', import.meta.url));
const sample = JSON.parse(await readFile(samplePath, 'utf8'));

test('totals are exact and hourly activity respects gaps', () => {
  const result = analyze(sample);
  assert.equal(result.totals.build, 320);
  assert.equal(result.totals.explore, 90);
  assert.equal(result.totals.connect, 80);
  assert.equal(result.totals.restore, 160);
  assert.equal(result.activeMinutes, 650);
  assert.equal(result.longestBuild, 150);
  assert.equal(result.hourly[16], 30);
  assert.equal(result.hourly[17], 50);
  assert.equal(result.hourly[20], 0);
});

test('out-of-order input is sorted; touching intervals are allowed', () => {
  const result = analyze({ title: 'x', blocks: [
    { start: '11:00', end: '12:00', category: 'build', label: 'Second' },
    { start: '10:00', end: '11:00', category: 'build', label: 'First' },
  ] });
  assert.deepEqual(result.blocks.map(({ label }) => label), ['First', 'Second']);
});

test('overlaps, invalid time, missing category and overnight intervals fail clearly', () => {
  const block = { start: '10:00', end: '11:00', category: 'build', label: 'One' };
  assert.throws(() => analyze({ title: 'x', blocks: [block, { ...block, start: '10:30', label: 'Two' }] }), /Overlapping/);
  assert.throws(() => toMinutes('24:00'), /Invalid time/);
  assert.throws(() => analyze({ title: 'x', blocks: [{ ...block, category: 'unknown' }] }), /unknown category/);
  assert.throws(() => analyze({ title: 'x', blocks: [{ ...block, end: '09:00' }] }), /split overnight/);
  assert.throws(() => analyze({ title: 'This title is too long to display on the card', blocks: [block] }), /32 characters/);
});

test('midnight-ending block can finish at 24:00', () => {
  const result = analyze({ title: 'x', blocks: [{ start: '23:30', end: '24:00', category: 'restore', label: 'Sleep' }] });
  assert.equal(result.totals.restore, 30);
});

test('large and small arcs use the correct sweep flag', () => {
  assert.match(arcPath(0, 60), / 0 0 1 /);
  assert.match(arcPath(0, 780), / 0 1 1 /);
});

test('render escapes arbitrary titles and labels and remains deterministic', () => {
  const unsafe = { title: 'Make <things> & learn', blocks: [{
    start: '08:00', end: '09:00', category: 'build', label: '"Sketch" <first>',
  }] };
  const svg = render(unsafe);
  assert.equal(svg, render(unsafe));
  assert.match(svg, /Make &lt;things&gt; &amp; learn/);
  assert.match(svg, /&quot;Sketch&quot; &lt;first&gt;/);
  assert.doesNotMatch(svg, /<first>/);
  assert.match(svg, /aria-labelledby="title description"/);
});

test('CLI writes valid SVG to a nested directory and reports errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'time-loom-'));
  try {
    const output = join(directory, 'nested', 'day.svg');
    const command = spawnSync(process.execPath, [scriptPath, samplePath, output], { encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
    assert.match(await readFile(output, 'utf8'), /^<svg /);
    const bad = spawnSync(process.execPath, [scriptPath, samplePath], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
