#!/usr/bin/env node
/** A schedule-to-SVG renderer with no runtime dependencies. */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const CATEGORIES = {
  build: { name: 'Build', color: '#e9aa70' },
  explore: { name: 'Explore', color: '#a9cdd1' },
  connect: { name: 'Connect', color: '#d5b8e5' },
  restore: { name: 'Restore', color: '#a7c9a4' },
};

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function toMinutes(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid time ${JSON.stringify(time)}; expected HH:MM (00:00–23:59)`);
  }
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function analyze(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('Schedule must be a JSON object');
  }
  if (typeof schedule.title !== 'string' || !schedule.title.trim()) {
    throw new Error('Schedule requires a nonempty title');
  }
  if (schedule.title.trim().length > 32) {
    throw new Error('Schedule title must be 32 characters or fewer to fit the card');
  }
  if (!Array.isArray(schedule.blocks) || !schedule.blocks.length) {
    throw new Error('Schedule requires at least one block');
  }

  const blocks = schedule.blocks.map((block, index) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`Block ${index + 1} must be an object`);
    }
    if (!Object.hasOwn(CATEGORIES, block.category)) {
      throw new Error(`Block ${index + 1} has unknown category ${JSON.stringify(block.category)}`);
    }
    if (typeof block.label !== 'string' || !block.label.trim()) {
      throw new Error(`Block ${index + 1} requires a nonempty label`);
    }
    const start = toMinutes(block.start);
    const end = block.end === '24:00' ? 1440 : toMinutes(block.end);
    if (end <= start) {
      throw new Error(`Block ${index + 1} must end after it starts; split overnight blocks`);
    }
    return { ...block, start, end, duration: end - start };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index].start < blocks[index - 1].end) {
      throw new Error(`Overlapping blocks: ${blocks[index - 1].label} / ${blocks[index].label}`);
    }
  }

  const totals = Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, 0]));
  const hourly = Array(24).fill(0);
  for (const block of blocks) {
    totals[block.category] += block.duration;
    for (let hour = Math.floor(block.start / 60); hour < Math.ceil(block.end / 60); hour += 1) {
      const overlap = Math.min(block.end, (hour + 1) * 60) - Math.max(block.start, hour * 60);
      hourly[hour] += overlap;
    }
  }

  const buildBlocks = blocks.filter((block) => block.category === 'build');
  const longestBuild = Math.max(0, ...buildBlocks.map((block) => block.duration));
  const activeMinutes = Object.values(totals).reduce((sum, minutes) => sum + minutes, 0);
  return { blocks, totals, hourly, longestBuild, activeMinutes };
}

function polar(cx, cy, radius, degrees) {
  const radians = (degrees - 90) * Math.PI / 180;
  return [cx + Math.cos(radians) * radius, cy + Math.sin(radians) * radius];
}

/** Return one SVG arc; the end is exclusive, preserving exact elapsed minutes. */
export function arcPath(startMinutes, endMinutes, radius = 212, cx = 326, cy = 350) {
  const startAngle = startMinutes / 1440 * 360;
  const endAngle = endMinutes / 1440 * 360;
  const [x1, y1] = polar(cx, cy, radius, startAngle);
  const [x2, y2] = polar(cx, cy, radius, endAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  // A complete day is two arcs, since identical endpoints cannot define a full circle.
  if (endMinutes - startMinutes === 1440) {
    return `${arcPath(0, 720, radius, cx, cy)} ${arcPath(720, 1440, radius, cx, cy)}`;
  }
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${String(remainder).padStart(2, '0')}m` : `${remainder}m`;
}

function formatTime(minutes) {
  if (minutes === 1440) return '24:00';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function render(schedule) {
  const { blocks, totals, hourly, longestBuild, activeMinutes } = analyze(schedule);
  const safeTitle = escapeXml(schedule.title.trim());
  const summary = `Build ${formatDuration(totals.build)}, explore ${formatDuration(totals.explore)}, connect ${formatDuration(totals.connect)}, restore ${formatDuration(totals.restore)}. Longest uninterrupted build block: ${formatDuration(longestBuild)}.`;

  const ticks = Array.from({ length: 24 }, (_, hour) => {
    const [x1, y1] = polar(326, 350, 246, hour * 15);
    const [x2, y2] = polar(326, 350, hour % 6 === 0 ? 265 : 255, hour * 15);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#aaa4a0" stroke-opacity="${hour % 6 === 0 ? '.65' : '.28'}" />`;
  }).join('\n      ');

  const arcs = blocks.map((block) => `<path d="${arcPath(block.start, block.end)}" stroke="${CATEGORIES[block.category].color}" stroke-width="39" fill="none" stroke-linecap="butt"><title>${formatTime(block.start)}–${formatTime(block.end)} · ${escapeXml(block.label)} · ${formatDuration(block.duration)}</title></path>`).join('\n      ');

  const barMax = Math.max(1, ...Object.values(totals));
  const categoryRows = Object.entries(CATEGORIES).map(([key, category], index) => {
    const y = 245 + index * 71;
    const barWidth = 333 * totals[key] / barMax;
    return `<g transform="translate(676 ${y})">
      <text y="-9" class="small">${category.name.toUpperCase()}</text>
      <text x="333" y="-9" text-anchor="end" class="number">${formatDuration(totals[key])}</text>
      <rect y="9" width="333" height="12" rx="6" fill="#ffffff" fill-opacity=".08" />
      <rect y="9" width="${barWidth.toFixed(1)}" height="12" rx="6" fill="${category.color}" />
    </g>`;
  }).join('\n    ');

  const hourlyBars = hourly.slice(6, 22).map((minutes, index) => {
    const x = 677 + index * 21;
    const height = minutes / 60 * 46;
    return `<rect x="${x}" y="${(631 - height).toFixed(1)}" width="12" height="${height.toFixed(1)}" rx="3" fill="${minutes === 60 ? '#e9aa70' : '#a9cdd1'}" fill-opacity="${minutes ? '.88' : '.18'}"><title>${String(index + 6).padStart(2, '0')}:00 · ${minutes} active minutes</title></rect>`;
  }).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720" viewBox="0 0 1100 720" role="img" aria-labelledby="title description">
  <title id="title">Time Loom · ${safeTitle}</title>
  <desc id="description">A 24-hour clock with colored schedule segments, category totals, and an hourly activity rhythm. ${escapeXml(summary)}</desc>
  <defs>
    <style>
      .small { fill: #b9b2ae; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 2px; }
      .number { fill: #faf0e6; font: 15px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .heading { fill: #faf0e6; font: 600 28px ui-sans-serif, system-ui, sans-serif; }
    </style>
  </defs>
  <rect width="1100" height="720" rx="25" fill="#171c23" />
  <circle cx="326" cy="350" r="294" fill="#202730" stroke="#faf0e6" stroke-opacity=".08" />
  <text x="70" y="71" class="small">TIME LOOM / A DAY IN COLOUR</text>
  <text x="676" y="103" class="small">A CIRCULAR STORY OF TIME</text>
  <text x="676" y="153" class="heading">${safeTitle}</text>
  <text x="676" y="194" class="small">WHERE THE DAY WENT</text>
  <circle cx="326" cy="350" r="212" fill="none" stroke="#faf0e6" stroke-opacity=".07" stroke-width="39" />
  <g>
      ${arcs}
  </g>
  <g>${ticks}</g>
  <text x="326" y="105" text-anchor="middle" class="small">00</text>
  <text x="598" y="356" text-anchor="middle" class="small">06</text>
  <text x="326" y="608" text-anchor="middle" class="small">12</text>
  <text x="54" y="356" text-anchor="middle" class="small">18</text>
  <text x="326" y="321" text-anchor="middle" class="small">RECORDED</text>
  <text x="326" y="376" text-anchor="middle" fill="#faf0e6" font-family="ui-sans-serif, system-ui, sans-serif" font-size="51" font-weight="600">${formatDuration(activeMinutes)}</text>
  <text x="326" y="409" text-anchor="middle" class="small">OF 24 HOURS</text>
  ${categoryRows}
  <line x1="676" y1="549" x2="1010" y2="549" stroke="#faf0e6" stroke-opacity=".12" />
  <text x="676" y="582" class="small">ACTIVITY RHYTHM / 06–22</text>
  ${hourlyBars}
  <text x="677" y="657" class="small">06</text>
  <text x="1010" y="657" text-anchor="end" class="small">22</text>
  <text x="676" y="696" class="small">LONGEST BUILD STRETCH · ${formatDuration(longestBuild)}</text>
</svg>
`;
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4) {
    console.error('Usage: node time_loom.mjs schedule.json output.svg');
    process.exitCode = 2;
    return;
  }
  try {
    const schedule = JSON.parse(await readFile(input, 'utf8'));
    const svg = render(schedule);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, svg, 'utf8');
    console.log(`Wove ${schedule.blocks.length} blocks into ${output}`);
  } catch (error) {
    console.error(`Time Loom: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
