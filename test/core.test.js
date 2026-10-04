import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopedFS } from '../src/index.js';

// ---- A small in-memory fs/path pair so tests never touch disk. ----------

class FakeStats {
  constructor(isDir) { this.isDirectory = () => isDir; this.isFile = () => !isDir; }
}

class Memory {
  constructor() { this.sep = '/'; this.delimiter = ':'; this.files = new Map(); this.dirs = new Set(['/']); }
  normalize(p) {
    // tiny posix normaliser, enough for resolve to behave
    const abs = p.startsWith('/') ? p : '/' + p;
    const out = [];
    for (const seg of abs.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return '/' + out.join('/');
  }
  resolve(...args) {
    let base = args.find(a => a.startsWith('/')) || '/';
    for (const a of args) {
      if (a.startsWith('/')) { base = a; continue; }
      base = this.normalize(base + '/' + a);
    }
    return this.normalize(base);
  }
  relative(from, to) {
    const f = this.resolve(from).split('/').filter(Boolean);
    const t = this.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    const up = f.length - i;
    const down = t.slice(i);
    return Array(up).fill('..').concat(down).join('/') || '.';
  }
  isAbsolute(p) { return typeof p === 'string' && p.startsWith('/'); }
  join(...args) { return this.normalize(args.join('/')); }
}

class MemoryFS {
  constructor() { this.m = new Memory(); this.files = new Map(); this.dirs = new Set(['/']); }
  readFileSync(p) {
    const n = this.m.normalize(p);
    if (!this.files.has(n)) { const e = new Error(`ENOENT: ${n}`); e.code = 'ENOENT'; throw e; }
    return this.files.get(n);
  }
  writeFileSync(p, data) {
    const n = this.m.normalize(p);
    const parent = n.slice(0, n.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent)) { const e = new Error(`ENOENT: dir ${parent}`); e.code = 'ENOENT'; throw e; }
    this.files.set(n, String(data));
  }
  unlinkSync(p) {
    const n = this.m.normalize(p);
    if (!this.files.has(n)) { const e = new Error(`ENOENT: ${n}`); e.code = 'ENOENT'; throw e; }
    this.files.delete(n);
  }
  existsSync(p) {
    const n = this.m.normalize(p);
    return this.files.has(n) || this.dirs.has(n);
  }
  statSync(p) {
    const n = this.m.normalize(p);
    if (this.files.has(n)) return new FakeStats(false);
    if (this.dirs.has(n)) return new FakeStats(true);
    const e = new Error(`ENOENT: ${n}`); e.code = 'ENOENT'; throw e;
  }
  mkdirSync(p) {
    const n = this.m.normalize(p);
    if (this.dirs.has(n)) { const e = new Error(`EEXIST: ${n}`); e.code = 'EEXIST'; throw e; }
    const parent = n.slice(0, n.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent)) { const e = new Error(`ENOENT: dir ${parent}`); e.code = 'ENOENT'; throw e; }
    this.dirs.add(n);
  }
  readdirSync(p) {
    const n = this.m.normalize(p);
    if (!this.dirs.has(n)) { const e = new Error(`ENOTDIR: ${n}`); e.code = 'ENOTDIR'; throw e; }
    const out = [];
    const prefix = n === '/' ? '/' : n + '/';
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) out.push(f.slice(prefix.length));
    }
    const seen = new Set();
    for (const d of this.dirs) {
      if (d === '/') continue;
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        const name = d.slice(prefix.length);
        if (!seen.has(name)) { out.push(name); seen.add(name); }
      }
    }
    return out;
  }
}

function makeBox() {
  const fs = new MemoryFS();
  const path = new Memory();
  fs.dirs.add('/box'); fs.dirs.add('/box/sub');
  const sfs = new ScopedFS('/box', { fs, path });
  return { sfs, fs, path };
}

// ---- Containment --------------------------------------------------------

test('root is normalised at construction', () => {
  const { sfs } = makeBox();
  assert.equal(sfs.root, '/box');
});

test('read within root succeeds', () => {
  const { sfs, fs } = makeBox();
  fs.writeFileSync('/box/notes.txt', 'hello');
  assert.equal(sfs.readFileSync('notes.txt'), 'hello');
});

test('write within root succeeds', () => {
  const { sfs, fs } = makeBox();
  sfs.writeFileSync('a.txt', 'x');
  assert.equal(fs.readFileSync('/box/a.txt'), 'x');
});

test('absolute path is rejected', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.readFileSync('/etc/passwd'), /absolute paths are not allowed/);
});

test('traversal escaping root is rejected', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.readFileSync('../secret'), /escapes sandbox root/);
});

test('traversal that stays inside root is allowed', () => {
  const { sfs, fs } = makeBox();
  fs.writeFileSync('/box/sub/inner.txt', 'v');
  assert.equal(sfs.readFileSync('sub/../sub/inner.txt'), 'v');
});

test('traversal to exactly root resolves to root', () => {
  const { sfs, fs } = makeBox();
  fs.dirs.add('/box');
  const list = sfs.readdirSync('.');
  assert.ok(Array.isArray(list));
});

test('traversal to parent of root is rejected', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.readdirSync('..'), /escapes sandbox root/);
});

test('empty path is rejected', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.readFileSync(''), /must not be empty/);
});

test('non-string path is rejected', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.readFileSync(42), /must be a string/);
});

// ---- Operations ---------------------------------------------------------

test('existsSync returns false for missing', () => {
  const { sfs } = makeBox();
  assert.equal(sfs.existsSync('nope.txt'), false);
});

test('existsSync returns true for present', () => {
  const { sfs, fs } = makeBox();
  fs.writeFileSync('/box/there.txt', 'y');
  assert.equal(sfs.existsSync('there.txt'), true);
});

test('unlinkSync removes file', () => {
  const { sfs, fs } = makeBox();
  fs.writeFileSync('/box/doomed.txt', 'z');
  sfs.unlinkSync('doomed.txt');
  assert.equal(sfs.existsSync('doomed.txt'), false);
});

test('statSync reports file vs dir', () => {
  const { sfs, fs } = makeBox();
  fs.writeFileSync('/box/f.txt', '1');
  assert.equal(sfs.statSync('f.txt').isFile(), true);
  assert.equal(sfs.statSync('sub').isDirectory(), true);
});

test('mkdirSync creates a directory', () => {
  const { sfs, fs } = makeBox();
  sfs.mkdirSync('newdir');
  assert.equal(fs.dirs.has('/box/newdir'), true);
});

test('readdirSync lists entries', () => {
  const { sfs, fs } = makeBox();
  fs.writeFileSync('/box/one.txt', '1');
  fs.writeFileSync('/box/two.txt', '2');
  const list = sfs.readdirSync('.').sort();
  assert.deepEqual(list, ['one.txt', 'sub', 'two.txt']);
});

// ---- Containment applies to every method --------------------------------

test('writeFileSync rejects escaping path', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.writeFileSync('../escape.txt', 'x'), /escapes sandbox root/);
});

test('unlinkSync rejects escaping path', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.unlinkSync('../escape.txt'), /escapes sandbox root/);
});

test('mkdirSync rejects escaping path', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.mkdirSync('../escape'), /escapes sandbox root/);
});

test('readdirSync rejects escaping path', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.readdirSync('..'), /escapes sandbox root/);
});

test('statSync rejects escaping path', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.statSync('../escape'), /escapes sandbox root/);
});

test('existsSync rejects escaping path', () => {
  const { sfs } = makeBox();
  assert.throws(() => sfs.existsSync('../escape'), /escapes sandbox root/);
});
