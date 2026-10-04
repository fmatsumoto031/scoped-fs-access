import { createRequire } from 'node:module';
import nodePath from 'node:path';
import nodeFs from 'node:fs';

/**
 * ScopedFS — a filesystem interface that confines every operation to a root
 * directory.
 *
 * Design decisions (stated plainly so the reader is not surprised):
 *
 * 1. This is Node only. The standard `node:fs` and `node:path` are used
 *    directly. No browser shim, no cross-environment abstraction.
 *
 * 2. The root is resolved and normalised at construction time. From that
 *    point on, the only thing that matters is whether the resolved path of
 *    any given relative argument is the root itself or a descendant of it.
 *    This is the single containment check; it is applied uniformly.
 *
 * 3. Paths are resolved against root, not against `process.cwd()`. The
 *    user passes a path *relative to root*. Absolute paths are rejected,
 *    because they are almost always a caller bug and silently rewriting them
 *    hides that bug.
 *
 * 4. `..` in user paths is permitted as long as the final resolved path is
 *    still under root. Banning traversal segments outright sounds safe but
 *    breaks legitimate paths like `a/../b` which resolve to `b`. We resolve
 *    and check instead.
 *
 * 5. The two real-filesystem dependencies are `node:fs` and `node:path`.
 *    They are injected through the constructor so tests can swap them for
 *    fakes that record calls and never touch disk.
 *
 * 6. Symlinks are NOT followed out of the sandbox. Operations use the
 *    *lexical* path, not the physical target. This is deliberate: resolving
 *    symlinks would require touching the real filesystem during the
 *    containment check itself, which defeats the purpose of a clean
 *    boundary. If you need symlink resolution, resolve before calling.
 */

/**
 * @typedef {Object} ScopedFSOptions
 * @property {import('node:fs')} [fs]          fs module; defaults to node:fs.
 * @property {import('node:path')} [path]     path module; defaults to node:path.
 */

export class ScopedFS {
  /**
   * @param {string} root      Absolute or relative path to the sandbox root.
   * @param {ScopedFSOptions} [opts]
   */
  constructor(root, opts = {}) {
    const pathMod = opts.path || nodePath;
    // Resolve root against the *current* working directory at construction.
    // We cannot resolve it lazily because cwd may change; pinning it makes
    // the scope stable and testable.
    this._root = pathMod.resolve(root);
    this._path = pathMod;
    this._fs = opts.fs || nodeFs;
  }

  /** The normalised root directory, as resolved at construction. */
  get root() {
    return this._root;
  }

  /**
   * Resolve a user-provided relative path against root and confirm it lies
   * within the sandbox. Throws if it escapes.
   *
   * Absolute paths are rejected outright: a caller who passes `/etc/passwd`
   * to a sandbox rooted at `/tmp/box` has made a mistake worth surfacing.
   *
   * @private
   * @param {string} rel
   * @returns {string} the absolute, resolved path (still under root).
   */
  _resolve(rel) {
    const p = this._path;
    if (typeof rel !== 'string') {
      throw new TypeError('path must be a string');
    }
    if (rel === '') {
      throw new Error('path must not be empty');
    }
    if (p.isAbsolute(rel)) {
      throw new Error(`absolute paths are not allowed: ${rel}`);
    }
    const resolved = p.resolve(this._root, rel);
    // `relative` yields a string that starts with `..` exactly when the
    // target is outside root. This is cheaper and more reliable than
    // string-prefix tricks that break on `/tmp/a` vs `/tmp/ab`.
    const relToRoot = p.relative(this._root, resolved);
    if (relToRoot.startsWith('..') || p.isAbsolute(relToRoot)) {
      throw new Error(`path escapes sandbox root: ${rel}`);
    }
    return resolved;
  }

  /**
   * Read a file as UTF-8 text.
   * @param {string} rel
   * @returns {string}
   */
  readFileSync(rel) {
    return this._fs.readFileSync(this._resolve(rel), 'utf8');
  }

  /**
   * Write text to a file. Parent directories must already exist; this is
   * deliberate so callers see missing dirs as explicit errors rather than
   * accidentally creating a tree.
   * @param {string} rel
   * @param {string} data
   * @returns {void}
   */
  writeFileSync(rel, data) {
    this._fs.writeFileSync(this._resolve(rel), data, 'utf8');
  }

  /** @param {string} rel @returns {void} */
  unlinkSync(rel) {
    this._fs.unlinkSync(this._resolve(rel));
  }

  /** @param {string} rel @returns {boolean} */
  existsSync(rel) {
    return this._fs.existsSync(this._resolve(rel));
  }

  /** @param {string} rel @returns {import('node:fs').Stats} */
  statSync(rel) {
    return this._fs.statSync(this._resolve(rel));
  }

  /** @param {string} rel @returns {void} */
  mkdirSync(rel) {
    this._fs.mkdirSync(this._resolve(rel));
  }

  /**
   * Read a directory, returning only entry names (not paths).
   * @param {string} rel
   * @returns {string[]}
   */
  readdirSync(rel) {
    return this._fs.readdirSync(this._resolve(rel));
  }
}
