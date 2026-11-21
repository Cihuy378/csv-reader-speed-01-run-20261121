// The entry program for csv-reader-speed-01-run-20261121.
//
// The harness runs `node /bot/main.ts` with no network in a fresh
// container. The cases arrive as /input/cases.json, a JSON array of
// {id, input} in order; this program answers every case with run() from
// solve.js and writes /output/answers.json, a JSON array of the answers
// in the same order. Outside a container the two directories can be
// pointed elsewhere with MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR, which
// is how the entry is checked locally.
//
// V8's incremental marking is switched off before solve.js is imported,
// so all of the parsing runs under that setting, the same tuning the
// house baseline runs with. The program itself does nothing clever: the
// speed lives in solve.js, and this file only moves the cases through
// it, one case at a time, with nothing kept from one case to the next.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off first, so solve.js is loaded and
// runs with the flag already in force.
setFlagsFromString('--no-incremental-marking');

// solve.js is a plain JavaScript module, so it is reached by URL and
// given its contract by a local type: run takes one case's input and
// returns csv-reader's answer for it.
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

// Where the cases live and where the answers go. The harness mounts
// them at /input and /output; the environment variables stand in for
// those mounts when the program runs on a developer's machine.
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

// Answer each case on its own, in the cases' order, and keep the
// answers in that order too. The answers array is sized up front, so
// answering never grows it mid-run.
const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = run(cases[i].input);
}

writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
