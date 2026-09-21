import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProvenance, SOURCES } from '../src/provenance.js';
import { EXAMPLE_REQUEST, EXAMPLE_CONFLICT_REQUEST } from '../src/example.js';

function mapByPath(result) {
  return new Map(result.provenance.map((entry) => [entry.path, entry]));
}

test('example clean merge: base/A/B/both leaves located at FINAL pointers', () => {
  const { status, provenance } = buildProvenance(
    EXAMPLE_REQUEST.base,
    EXAMPLE_REQUEST.patchA,
    EXAMPLE_REQUEST.patchB,
  );
  assert.equal(status, 'clean');
  const byPath = mapByPath({ provenance });

  // untouched leaves stay "base"
  assert.equal(byPath.get('/app').source, SOURCES.BASE);
  assert.deepEqual(byPath.get('/app').contributors, []);
  assert.equal(byPath.get('/features/cache').source, SOURCES.BASE);
  assert.equal(byPath.get('/tags/0').source, SOURCES.BASE);

  // A-only scalar replace
  assert.equal(byPath.get('/replicas').source, SOURCES.A);
  assert.deepEqual(byPath.get('/replicas').contributors, [{ side: 'A', index: 0 }]);

  // B-only new object member
  assert.equal(byPath.get('/features/retries').source, SOURCES.B);
  assert.deepEqual(byPath.get('/features/retries').contributors, [{ side: 'B', index: 2 }]);

  // identical write on both sides -> both, both original indices, A then B
  const tracing = byPath.get('/features/tracing');
  assert.equal(tracing.source, SOURCES.BOTH);
  assert.deepEqual(tracing.contributors, [
    { side: 'A', index: 2 },
    { side: 'B', index: 3 },
  ]);

  // Array relocation: B removes base[0]; A's gap-1 insert and B's gap-1 insert
  // plus the surviving base element are all located at their FINAL indices.
  // merged.servers = [a2(A#1), b2(B#1), b.internal(base)]
  for (const leaf of ['/servers/0/host', '/servers/0/port']) {
    assert.equal(byPath.get(leaf).source, SOURCES.A);
    assert.deepEqual(byPath.get(leaf).contributors, [{ side: 'A', index: 1 }]);
  }
  for (const leaf of ['/servers/1/host', '/servers/1/port']) {
    assert.equal(byPath.get(leaf).source, SOURCES.B);
    assert.deepEqual(byPath.get(leaf).contributors, [{ side: 'B', index: 1 }]);
  }
  for (const leaf of ['/servers/2/host', '/servers/2/port']) {
    assert.equal(byPath.get(leaf).source, SOURCES.BASE);
  }
});

test('entries are sorted by escaped RFC 6901 pointer (UTF-16 code units)', () => {
  const { provenance } = buildProvenance(
    EXAMPLE_REQUEST.base,
    EXAMPLE_REQUEST.patchA,
    EXAMPLE_REQUEST.patchB,
  );
  const paths = provenance.map((e) => e.path);
  const sorted = [...paths].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  assert.deepEqual(paths, sorted);
  // every path is unique and every entry carries contributors
  assert.equal(new Set(paths).size, paths.length);
  for (const entry of provenance) assert.ok(Array.isArray(entry.contributors));
});

test('array index drift: inserts, removes and deep edits relocate by base identity', () => {
  const base = {
    servers: [
      { host: 'a', weight: 1 },
      { host: 'b', weight: 2 },
      { host: 'c', weight: 3 },
    ],
  };
  const patchA = [
    { op: 'add', path: '/servers/0', value: { host: 'new', weight: 9 } },
    { op: 'replace', path: '/servers/2/weight', value: 33 },
  ];
  const patchB = [{ op: 'remove', path: '/servers/0' }];
  const { provenance } = buildProvenance(base, patchA, patchB);
  const byPath = mapByPath({ provenance });
  // merged: [new(A#0 gap-0 insert), b(base), c with weight A#1]
  assert.equal(byPath.get('/servers/0/host').source, SOURCES.A);
  assert.deepEqual(byPath.get('/servers/0/host').contributors, [{ side: 'A', index: 0 }]);
  assert.equal(byPath.get('/servers/1/host').source, SOURCES.BASE);
  assert.equal(byPath.get('/servers/2/host').source, SOURCES.BASE);
  // deep edit on base element 2 relocated to final index 2
  assert.equal(byPath.get('/servers/2/weight').source, SOURCES.A);
  assert.deepEqual(byPath.get('/servers/2/weight').contributors, [{ side: 'A', index: 1 }]);
  // removed base element a leaves no leaves
  assert.equal(byPath.has('/servers/3/host'), false);
});

test('same insertion gap: A inserts before B, each attributed to its own index', () => {
  const { provenance } = buildProvenance(
    { list: ['x', 'y'] },
    [{ op: 'add', path: '/list/1', value: 'from-A' }],
    [{ op: 'add', path: '/list/1', value: 'from-B' }],
  );
  const byPath = mapByPath({ provenance });
  assert.equal(byPath.get('/list/0').source, SOURCES.BASE); // x
  assert.equal(byPath.get('/list/1').source, SOURCES.A); // from-A
  assert.equal(byPath.get('/list/2').source, SOURCES.B); // from-B
  assert.equal(byPath.get('/list/3').source, SOURCES.BASE); // y
});

test('"-" append gap shared between patches: A before B', () => {
  const { provenance } = buildProvenance(
    ['a'],
    [{ op: 'add', path: '/-', value: 'A' }],
    [{ op: 'add', path: '/1', value: 'B' }],
  );
  const byPath = mapByPath({ provenance });
  assert.equal(byPath.get('/0').source, SOURCES.BASE);
  assert.equal(byPath.get('/1').source, SOURCES.A);
  assert.equal(byPath.get('/2').source, SOURCES.B);
});

test('identical replace and identical remove are credited to both original indices', () => {
  const replace = buildProvenance(
    { x: 1, y: 2 },
    [{ op: 'replace', path: '/x', value: 5 }],
    [{ op: 'replace', path: '/x', value: 5 }],
  );
  const entry = replace.provenance.find((e) => e.path === '/x');
  assert.equal(entry.source, SOURCES.BOTH);
  assert.deepEqual(entry.contributors, [
    { side: 'A', index: 0 },
    { side: 'B', index: 0 },
  ]);

  // identical remove: the leaf simply disappears (no entry), and it is not a
  // conflict — other leaves are still reported.
  const removed = buildProvenance(
    { x: 1, y: 2 },
    [{ op: 'remove', path: '/x' }],
    [{ op: 'remove', path: '/x' }],
  );
  assert.equal(removed.status, 'clean');
  assert.equal(removed.provenance.some((e) => e.path === '/x'), false);
  assert.equal(removed.provenance.find((e) => e.path === '/y').source, SOURCES.BASE);
});

test('identical add of a new object member is "both" across the whole subtree', () => {
  const { provenance } = buildProvenance(
    { a: 1 },
    [{ op: 'add', path: '/x', value: { k: 1, z: 2 } }],
    [{ op: 'add', path: '/x', value: { k: 1, z: 2 } }],
  );
  for (const path of ['/x/k', '/x/z']) {
    const entry = provenance.find((e) => e.path === path);
    assert.equal(entry.source, SOURCES.BOTH);
    assert.deepEqual(entry.contributors, [
      { side: 'A', index: 0 },
      { side: 'B', index: 0 },
    ]);
  }
});

test('last write wins: earlier shadowed op within one patch is not a contributor', () => {
  const { provenance } = buildProvenance(
    { m: 1 },
    [
      { op: 'replace', path: '/m', value: 9 },
      { op: 'replace', path: '/m', value: 10 },
    ],
    [],
  );
  const entry = provenance.find((e) => e.path === '/m');
  assert.equal(entry.source, SOURCES.A);
  assert.deepEqual(entry.contributors, [{ side: 'A', index: 1 }]);
});

test('delete then re-create at the same member / array gap locates the new write', () => {
  // object member: remove then re-add within one patch -> last write
  const objectCase = buildProvenance(
    { k: { old: true } },
    [
      { op: 'remove', path: '/k' },
      { op: 'add', path: '/k', value: { fresh: 1 } },
    ],
    [],
  );
  const byPath = mapByPath(objectCase);
  assert.equal(byPath.has('/k/old'), false);
  assert.equal(byPath.get('/k/fresh').source, SOURCES.A);
  assert.deepEqual(byPath.get('/k/fresh').contributors, [{ side: 'A', index: 1 }]);

  // array gap: B deletes base element 0, A inserts into the same gap — the
  // inserted value is located at final index 0.
  const arrayCase = buildProvenance(
    { list: [{ n: 1 }, { n: 2 }] },
    [{ op: 'add', path: '/list/0', value: { n: 99 } }],
    [{ op: 'remove', path: '/list/0' }],
  );
  const a = mapByPath(arrayCase);
  assert.equal(a.get('/list/0/n').source, SOURCES.A);
  assert.deepEqual(a.get('/list/0/n').contributors, [{ side: 'A', index: 0 }]);
  assert.equal(a.get('/list/1/n').source, SOURCES.BASE);
});

test('wholesale subtree replace attributes every leaf inside to the writer', () => {
  const { provenance } = buildProvenance(
    { db: { host: 'old', port: 1 }, keep: true },
    [{ op: 'replace', path: '/db', value: { host: 'new', port: 2, tls: true } }],
    [],
  );
  const byPath = mapByPath({ provenance });
  for (const path of ['/db/host', '/db/port', '/db/tls']) {
    assert.equal(byPath.get(path).source, SOURCES.A);
    assert.deepEqual(byPath.get(path).contributors, [{ side: 'A', index: 0 }]);
  }
  assert.equal(byPath.get('/keep').source, SOURCES.BASE);
});

test('empty objects and arrays are leaves too', () => {
  const { provenance } = buildProvenance(
    { e: [], o: { x: 1 } },
    [{ op: 'replace', path: '/e', value: [] }],
    [{ op: 'add', path: '/o/n', value: {} }],
  );
  const byPath = mapByPath({ provenance });
  assert.equal(byPath.get('/e').source, SOURCES.A);
  assert.equal(byPath.get('/o/n').source, SOURCES.B);
  assert.equal(byPath.get('/o/x').source, SOURCES.BASE);
});

test('document-root replace attributes every leaf to the root op', () => {
  const scalar = buildProvenance(1, [{ op: 'replace', path: '', value: 2 }], []);
  assert.deepEqual(scalar.provenance, [
    { path: '', source: SOURCES.A, contributors: [{ side: 'A', index: 0 }] },
  ]);

  const array = buildProvenance({ a: 1 }, [{ op: 'replace', path: '', value: [1, 2] }], []);
  assert.deepEqual(
    array.provenance.map((e) => e.path),
    ['/0', '/1'],
  );
});

test('escaped JSON Pointer tokens are reported escaped and sorted', () => {
  const { provenance } = buildProvenance(
    { 'a/b': 1, 'a~b': 2 },
    [{ op: 'replace', path: '/a~1b', value: 10 }],
    [{ op: 'replace', path: '/a~0b', value: 20 }],
  );
  assert.deepEqual(
    provenance.map((e) => e.path),
    // sorting is over the ESCAPED pointer strings: after the common "/a~",
    // "0" (0x30) precedes "1" (0x31), regardless of the raw-key order.
    ['/a~0b', '/a~1b'],
  );
});

test('conflict record returns status conflict with no provenance', () => {
  const result = buildProvenance(
    EXAMPLE_CONFLICT_REQUEST.base,
    EXAMPLE_CONFLICT_REQUEST.patchA,
    EXAMPLE_CONFLICT_REQUEST.patchB,
  );
  assert.equal(result.status, 'conflict');
  assert.equal(result.provenance, null);
});

test('pure function: repeated builds are deeply equal', () => {
  const first = buildProvenance(
    EXAMPLE_REQUEST.base,
    EXAMPLE_REQUEST.patchA,
    EXAMPLE_REQUEST.patchB,
  );
  const second = buildProvenance(
    EXAMPLE_REQUEST.base,
    EXAMPLE_REQUEST.patchA,
    EXAMPLE_REQUEST.patchB,
  );
  assert.deepEqual(first, second);
});
