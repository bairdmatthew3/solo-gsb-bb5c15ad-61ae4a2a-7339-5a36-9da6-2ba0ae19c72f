/**
 * Leaf provenance for a clean base-coordinate rehearsal merge.
 *
 * For every leaf (terminal value) of the merged document this reports where it
 * came from:
 *  - "base": unchanged from the base document;
 *  - "A" / "B": written solely by one patch (original operation indices listed);
 *  - "both": written by both patches with identical values — the identical
 *    write is applied once, but BOTH original indices are credited.
 *
 * Attribution replays the SAME base-coordinate rules as merge.js:
 *  - object members group by key; the last write at one member wins, so an
 *    earlier write shadowed by a later one inside the same patch is not a
 *    contributor ("last write wins");
 *  - arrays are rebuilt from BASE element identities: insertions occupy the
 *    gap before a base element (same-gap order: A inserts before B inserts,
 *    in-patch order preserved), removes/replaces/deep edits address base
 *    indices regardless of index drift — every contributor is located at the
 *    element's FINAL index, i.e. its JSON Pointer in the merged document;
 *  - a remove followed by a re-creation is simply the surviving write emitted
 *    into the same gap/member.
 *
 * The walk starts from the BASE document and the surviving normalized
 * operations (mirroring applyMerge in merge.js); an independent scan of the
 * merged document's terminal paths is then compared with the attributed paths
 * — any mismatch is a ProvenanceError (defensive; cannot occur for a clean
 * merge).
 *
 * The result is a pure function of the saved inputs: entries are sorted by
 * escaped RFC 6901 pointer (UTF-16 code units) and contributors by
 * (side, original index), so cached answers serialize byte-for-byte.
 */

import { prepareMerge, formatPointer } from './merge.js';

export const SOURCES = Object.freeze({
  BASE: 'base',
  A: 'A',
  B: 'B',
  BOTH: 'both',
});

export class ProvenanceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProvenanceError';
    this.code = details.code || 'PROVENANCE_ERROR';
    this.details = details;
  }
}

/* ------------------------------- contributors ----------------------------- */

const refOf = (op) => ({ side: op.side, index: op.index });

function bySideThenIndex(x, y) {
  return x.side.localeCompare(y.side) || x.index - y.index;
}

/** Merge contributor lists without duplicating a side+index pair. */
function unionRefs(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const ref of list) {
      const key = `${ref.side}#${ref.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out.sort(bySideThenIndex);
}

function sourceOf(refs) {
  if (!refs.length) return SOURCES.BASE;
  const sides = new Set(refs.map((r) => r.side));
  if (sides.has('A') && sides.has('B')) return SOURCES.BOTH;
  return sides.has('A') ? SOURCES.A : SOURCES.B;
}

/* ------------------------------- leaf model ------------------------------- */

function isContainer(v) {
  return v !== null && typeof v === 'object';
}

/** A terminal value is a scalar/null or an EMPTY object/array. */
function isTerminal(v) {
  if (!isContainer(v)) return true;
  if (Array.isArray(v)) return v.length === 0;
  return Object.keys(v).length === 0;
}

/* ------------------------------- attribution ------------------------------ */

/**
 * Emit one provenance entry per terminal path, traversing the BASE document
 * with the surviving normalized ops while carrying the corresponding MERGED
 * result node — the same traversal applyMerge uses to build merged (objects
 * group by key; arrays rebuild from base element identities), so each emitted
 * pointer is the FINAL pointer in the merged document.
 *
 * Carrying `result` is essential when a deep edit empties a container: the
 * base node is still non-terminal while the result is an empty object/array,
 * which is itself a leaf.
 *
 * A wholesale-written subtree is enumerated by walkWritten on its own: nested
 * operations under an add/replace ancestor cannot survive a clean merge
 * (rejected intra-patch, or a replace-overlap conflict cross-patch).
 *
 * Removes need no special bookkeeping beyond mirroring applyObject/applyArray:
 * an identical cross-side remove keeps a surviving twin, and a descendant
 * remove covered by a surviving ancestor remove is never reached (the ancestor
 * write skips its whole subtree).
 */
function walk(node, result, ops, segments, entries, seenPaths) {
  const emit = makeEmitter(entries, seenPaths);

  // A write at this exact node replaces the whole subtree.
  const here = ops.filter((op) => op.segments.length === 0);
  if (here.length) {
    const writer = here[here.length - 1];
    if (writer.op === 'remove') return; // whole node deleted
    walkWritten(writer.value, writeRefs(here), segments, entries, seenPaths);
    return;
  }

  // Terminal decision is on the RESULT node: deep removes may have emptied a
  // container that was non-terminal in base. The residual empty container
  // survives by base identity, hence source "base".
  if (isTerminal(result)) {
    emit(segments, []);
    return;
  }

  if (Array.isArray(node)) {
    walkArray(node, result, ops, segments, entries, seenPaths);
  } else {
    walkObject(node, result, ops, segments, entries, seenPaths);
  }
}

function makeEmitter(entries, seenPaths) {
  return (leafSegments, leafRefs) => {
    const path = formatPointer(leafSegments);
    if (seenPaths.has(path)) {
      throw new ProvenanceError(`duplicate provenance leaf at ${path}`, {
        code: 'PROVENANCE_DUPLICATE_LEAF',
        path,
      });
    }
    seenPaths.add(path);
    entries.push({ path, source: sourceOf(leafRefs), contributors: leafRefs });
  };
}

/** Contributors of a write site: each surviving op plus any identical twin. */
function writeRefs(hereOps) {
  return unionRefs(...hereOps.map((op) => [refOf(op), ...(op.extraRefs ?? [])]));
}

/** Enumerate the terminal paths of a wholesale-written value. */
function walkWritten(value, refs, segments, entries, seenPaths) {
  const emit = makeEmitter(entries, seenPaths);

  if (isTerminal(value)) {
    emit(segments, refs);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => walkWritten(el, refs, [...segments, String(i)], entries, seenPaths));
  } else {
    for (const key of Object.keys(value)) {
      walkWritten(value[key], refs, [...segments, key], entries, seenPaths);
    }
  }
}

function walkObject(obj, result, ops, segments, entries, seenPaths) {
  const groups = new Map();
  for (const op of ops) {
    const key = op.segments[0];
    let g = groups.get(key);
    if (!g) {
      g = { here: [], deeper: [] };
      groups.set(key, g);
    }
    if (op.segments.length === 1) g.here.push(op);
    else g.deeper.push({ ...op, segments: op.segments.slice(1) });
  }

  // Existing base members: written, deep-edited, removed or untouched.
  for (const key of Object.keys(obj)) {
    const child = [...segments, key];
    const g = groups.get(key);
    if (!g) {
      walk(obj[key], result[key], [], child, entries, seenPaths);
      continue;
    }
    if (g.here.length) {
      const writer = g.here[g.here.length - 1]; // last write wins within a side
      if (writer.op === 'remove') continue; // mirrors applyObject: delete obj[key]
      walkWritten(writer.value, writeRefs(g.here), child, entries, seenPaths);
      continue;
    }
    walk(obj[key], result[key], g.deeper, child, entries, seenPaths);
  }

  // Members created by add operations (absent from base).
  for (const [key, g] of groups) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const child = [...segments, key];
    if (g.here.length) {
      const writer = g.here[g.here.length - 1];
      if (writer.op === 'remove') continue; // cannot remove a missing member on a clean merge
      walkWritten(writer.value, writeRefs(g.here), child, entries, seenPaths);
    } else {
      // Deep edits cannot create a missing member on a clean merge.
      walk(undefined, result[key], g.deeper, child, entries, seenPaths);
    }
  }
}

/**
 * Rebuild the array from BASE identities exactly like applyArray in merge.js,
 * resolving every contributor to the FINAL index. `result` is the merged
 * array; a surviving base element's result value is read at its final index.
 */
function walkArray(arr, result, ops, segments, entries, seenPaths) {
  const groups = new Map(); // base index -> { adds, remove, replace, deeper }
  for (const op of ops) {
    const idx = Number(op.segments[0]);
    let g = groups.get(idx);
    if (!g) {
      g = { adds: [], remove: null, replace: null, deeper: [] };
      groups.set(idx, g);
    }
    if (op.segments.length === 1) {
      if (op.arrayInsert) g.adds.push(op); // keeps [A..., B...] encounter order
      else if (op.op === 'remove') g.remove = op;
      else g.replace = op;
    } else {
      g.deeper.push({ ...op, segments: op.segments.slice(1) });
    }
  }

  let finalIndex = 0;
  for (let i = 0; i <= arr.length; i++) {
    const g = groups.get(i);

    // Insertions into gap i (same gap: A's values before B's, in-patch order).
    if (g) {
      for (const add of g.adds) {
        const child = [...segments, String(finalIndex)];
        walkWritten(add.value, writeRefs([add]), child, entries, seenPaths);
        finalIndex++;
      }
    }
    if (i === arr.length) break;

    if (g && g.remove) {
      // Deleted base element contributes nothing; a co-located insertion into
      // the same gap was already emitted above ("delete then re-create").
      continue;
    }

    const child = [...segments, String(finalIndex)];
    if (g && g.replace) {
      walkWritten(g.replace.value, writeRefs([g.replace]), child, entries, seenPaths);
      finalIndex++;
      continue;
    }

    walk(arr[i], result[finalIndex], g ? g.deeper : [], child, entries, seenPaths);
    finalIndex++;
  }
}

/* --------------------------- terminal-pointer scan ------------------------ */

/** Independent scan of every terminal path of a value. */
function terminalPointers(value, segments = [], out = []) {
  if (isTerminal(value)) {
    out.push(formatPointer(segments));
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => terminalPointers(el, [...segments, String(i)], out));
  } else {
    for (const key of Object.keys(value)) {
      terminalPointers(value[key], [...segments, key], out);
    }
  }
  return out;
}

/* --------------------------------- entry --------------------------------- */

/**
 * Build the provenance report for a saved rehearsal's inputs.
 *
 * Returns { status: 'clean', provenance } with provenance entries sorted by
 * path, or { status: 'conflict', provenance: null } (the route answers 409).
 */
export function buildProvenance(base, patchA, patchB) {
  const prepared = prepareMerge(base, patchA, patchB);
  if (prepared.status !== 'clean') {
    return { status: 'conflict', provenance: null };
  }

  // Identical writes are applied once but both originals are contributors:
  // tag the surviving op with the deduplicated twin's ref.
  const twinRefs = new Map();
  for (const { survivor, duplicate } of prepared.duplicates) {
    twinRefs.set(survivor.id, unionRefs(twinRefs.get(survivor.id) ?? [], [refOf(duplicate)]));
  }
  const ops = prepared.surviving.map((op) => {
    const twins = twinRefs.get(op.id);
    return twins ? { ...op, extraRefs: twins } : op;
  });

  const entries = [];
  const seenPaths = new Set();
  walk(base, prepared.merged, ops, [], entries, seenPaths);

  // The walk must cover exactly the terminal paths of the merged document.
  const expected = terminalPointers(prepared.merged).sort();
  const actual = [...seenPaths].sort();
  if (expected.length !== actual.length || expected.some((p, i) => p !== actual[i])) {
    const missing = expected.filter((p) => !seenPaths.has(p));
    const unexpected = actual.filter((p) => !new Set(expected).has(p));
    throw new ProvenanceError(
      'provenance leaves do not match the merged document terminal paths',
      { code: 'PROVENANCE_LEAF_MISMATCH', missing, unexpected },
    );
  }

  entries.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  for (const entry of entries) entry.contributors.sort(bySideThenIndex);
  return { status: 'clean', provenance: entries };
}
