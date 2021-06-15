const browserify = require('browserify');
const chokidar = require('chokidar');
const concat = require('concat-stream');
const EventEmitter = require('events');
const fs = require('fs');
const mold = require('@frida/mold-source-map');
const path = require('path');
const through = require('through2');
const tsify = require('tsify');
const util = require('util');

const access = util.promisify(fs.access);
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);

const fridaBuiltins = Object.assign({}, require('browserify/lib/builtins'), {
  '_process': require.resolve('frida-process'),
  'any-promise': require.resolve('frida-any-promise'),
  'bignum': require.resolve('bignumber.js'),
  'buffer': require.resolve('frida-buffer'),
  'fs': require.resolve('frida-fs'),
  'http': require.resolve('frida-http'),
  'iconv': require.resolve('./lib/iconv'),
  'net': require.resolve('frida-net'),
  'node-icu-charset-detector': require.resolve('./lib/node-icu-charset-detector'),
  'supports-color': require.resolve('./lib/supports-color'),
});

let getSystemSessionRequest = null;

async function build(inputPath, outputPath, options) {
  options = options || {};

  const compile = makeCompiler(inputPath, {}, options);
  const result = await compile();

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.bundle);

  return result;
}

function watch(inputPath, outputPath, options) {
  const cache = {};
  const compile = makeCompiler(inputPath, cache, options);
  const events = new EventEmitter();
  let canonicalizeFilename;
  let absoluteOutputPath;
  const watcher = chokidar.watch([], {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
  });
  let watchedFiles = new Map();
  let watchedDirs = new Map();
  const onChangeCallbacks = [];
  let changed = new Set();
  let lastChange = null;
  let timer = null;
  const ON_CHANGE_DELAY = 50;

  options = options || {};

  async function run() {
    try {
      await access(path.join(__dirname, path.basename(__filename).toUpperCase()), fs.constants.OK);
      canonicalizeFilename = canonicalizeCaseInsensitiveFilename;
    } catch (e) {
      canonicalizeFilename = canonicalizeCaseSensitiveFilename;
    }

    absoluteOutputPath = canonicalizeFilename(path.resolve(outputPath));

    await mkdir(path.dirname(outputPath), { recursive: true });

    watcher.on('change', onChange);
    watcher.on('unlink', path => {
      watchedFiles.delete(path);
      onChange(path);
    });

    let changedFiles = new Set();

    while (true) {
      try {
        const startFiles = new Set(Object.keys(cache));
        const startTime = Date.now();

        const result = await compile();

        const duration = Date.now() - startTime;
        const files = Array.from(new Set(
            Object.keys(cache)
            .filter(file => !startFiles.has(file))
            .concat(Array.from(changedFiles))));

        events.emit('compile', { files, duration });

        updateWatchedFiles(result.inputs);

        await writeFile(outputPath, result.bundle);
      } catch (e) {
        events.emit('error', e);

        addWatchedFiles(e.inputs);
      }

      changedFiles = await waitForChange();
      const cachedFiles = Object.keys(cache)
          .reduce((result, name) => result.set(canonicalizeFilename(name), name), new Map());
      changedFiles.forEach(file => delete cache[cachedFiles.get(file)]);
    }
  };

  run()
      .catch(error => {
        events.emit('error', error);
      });

  return events;

  function updateWatchedFiles(current) {
    const files = Array.from(current)
        .reduce((result, name) => result.set(canonicalizeFilename(name), name), new Map());
    files.delete(absoluteOutputPath);

    const dirs = Array.from(new Set(Array.from(files.values()).map(path.dirname)))
        .reduce((result, name) => result.set(canonicalizeFilename(name), name), new Map());

    const added = Array.from(dirs.keys())
        .filter(id => !watchedDirs.has(id))
        .map(id => dirs.get(id));
    const removed = Array.from(watchedDirs.keys())
        .filter(id => !dirs.has(id))
        .map(id => watchedDirs.get(id));

    watchedFiles = files;
    watchedDirs = dirs;

    watcher.unwatch(removed);
    watcher.add(added);
  }

  function addWatchedFiles(files) {
    updateWatchedFiles(new Set([...watchedFiles.values(), ...files]));
  }

  function waitForChange() {
    return new Promise(resolve => {
      if (changed.size === 0) {
        onChangeCallbacks.push(resolve);
      } else {
        const c = changed;
        changed = new Set();
        resolve(c);
      }
    });
  }

  function onChange(filename) {
    const id = canonicalizeFilename(filename);
    if (!watchedFiles.has(id))
      return;

    changed.add(id);

    lastChange = Date.now();
    if (timer === null)
      timer = setTimeout(onChangeTimeout, ON_CHANGE_DELAY);
  }

  function onChangeTimeout() {
    const delta = Date.now() - lastChange;
    if (delta < ON_CHANGE_DELAY) {
      timer = setTimeout(onChangeTimeout, ON_CHANGE_DELAY - delta);
    } else {
      timer = null;

      if (onChangeCallbacks.length > 0) {
        onChangeCallbacks.splice(0).forEach(callback => callback(changed));
        changed = new Set();
      }
    }
  }

  function canonicalizeCaseSensitiveFilename(name) {
    return name;
  }

  function canonicalizeCaseInsensitiveFilename(name) {
    return name.toLowerCase();
  }
}

function makeCompiler(entrypoint, cache, options) {
  const inputs = new Set([ entrypoint ]);

  const b = browserify(entrypoint, {
    basedir: process.cwd(),
    extensions: ['.js', '.json', '.cy', '.ts'],
    builtins: fridaBuiltins,
    cache: cache,
    debug: options.sourcemap,
    standalone: options.standalone
  })
  .plugin(tsify, {
    forceConsistentCasingInFileNames: true,
    project: options.tsconfig
  })
  .on('package', pkg => {
    inputs.add(path.join(pkg.__dirname, 'package.json'));
  })
  .on('file', file => {
    inputs.add(file);
  })
  .transform(file => {
    const isCylang = file.lastIndexOf('.cy') === file.length - 3;
    if (!isCylang)
      return through();

    const chunks = [];
    let size = 0;
    return through(
      function (chunk, enc, callback) {
        chunks.push(chunk);
        size += chunk.length;
        callback();
      },
      function (callback) {
        const code = Buffer.concat(chunks, size).toString();
        try {
          let cylang;

          try {
            cylang = require('cylang');
          } catch (e) {
            throw new Error('Please `npm install cylang` for .cy compilation support');
          }

          const js = cylang.compile(code, {
            strict: false,
            pretty: true
          });

          this.push(new Buffer(js));

          callback();
        } catch (e) {
          callback(e);
        }
      }
    );
  });

  if (options.compress) {
    b.transform({
      global: true,
      mangle: {
        toplevel: true
      },
      output: {
        beautify: true,
        indent_level: 2
      }
    }, '@frida/uglifyify');
  }

  b.pipeline.get('deps').push(through.obj(function (row, enc, next) {
    const file = row.expose ? b._expose[row.id] : row.file;
    inputs.add(file);
    cache[file] = {
      source: row.source,
      deps: Object.assign({}, row.deps)
    };
    this.push(row);
    next();
  }));

  return function () {
    return new Promise((resolve, reject) => {
      b
      .bundle()
      .on('error', e => {
        e.inputs = inputs;
        reject(e);
      })
      .pipe(options.sourcemap ? mold.transform(trimSourceMap) : through.obj())
      .pipe(concat(buf => {
        if (options.bytecode) {
          compileToBytecode(buf.toString())
          .then(bytecode => {
            resolve({
              bundle: bytecode,
              inputs: inputs
            });
          })
          .catch(reject);
        } else {
          resolve({
            bundle: buf,
            inputs: inputs
          });
        }
      }));
    });
  };
}

async function compileToBytecode(source) {
  const systemSession = await getSystemSession();
  const bytecode = await systemSession.compileScript(source);
  return bytecode;
}

function getSystemSession() {
  if (getSystemSessionRequest === null)
    getSystemSessionRequest = attachToSystemSession();
  return getSystemSessionRequest;
}

async function attachToSystemSession() {
  let frida;

  try {
    frida = require('frida');
  } catch (e) {
    throw new Error('Please `npm install frida` for bytecode compilation support');
  }

  return await frida.attach(0);
}

function trimSourceMap(molder) {
  var map = molder.sourcemap;
  if (map === undefined)
    return '';
  map.setProperty('sourcesContent', undefined);
  return map.toComment();
}

module.exports = {
  makeCompiler,
  build,
  watch
};
