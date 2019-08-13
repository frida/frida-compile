const babelify = require('babelify');
const browserify = require('browserify');
const chokidar = require('chokidar');
const concat = require('concat-stream');
const esmify = require('esmify');
const EventEmitter = require('events');
const fs = require('fs');
const _mkdirp = require('mkdirp');
const mold = require('mold-source-map');
const path = require('path');
const through = require('through2');
const tsify = require('tsify');
const util = require('util');

const mkdirp = util.promisify(_mkdirp);
const writeFile = util.promisify(fs.writeFile);

const fridaBuiltins = Object.assign({}, require('browserify/lib/builtins'), {
  '_process': require.resolve('frida-process'),
  'buffer': require.resolve('frida-buffer'),
  'fs': require.resolve('frida-fs'),
  'net': require.resolve('frida-net'),
  'http': require.resolve('frida-http'),
  'bignum': require.resolve('bignumber.js'),
  'any-promise': require.resolve('frida-any-promise'),
  'supports-color': require.resolve('./lib/supports-color'),
});

let getSystemSessionRequest = null;

async function build(inputPath, outputPath, options) {
  options = options || {};

  const result = await compile(inputPath, {}, options);

  await mkdirp(path.dirname(outputPath));
  await writeFile(outputPath, result.bundle);

  return result;
}

function watch(inputPath, outputPath, options) {
  const events = new EventEmitter();
  const cache = {};
  const watcher = chokidar.watch([], { persistent: true });
  let watched = new Set();
  const onChangeCallbacks = [];
  let changed = new Set();
  let lastChange = null;
  let timer = null;
  const ON_CHANGE_DELAY = 50;

  options = options || {};

  async function run() {
    watcher.on('change', onChange);
    watcher.on('unlink', path => {
      watched.delete(path);
      onChange(path);
    });

    await mkdirp(path.dirname(outputPath));

    while (true) {
      try {
        const startFiles = new Set(Object.keys(cache));
        const startTime = Date.now();

        const result = await compile(inputPath, cache, options);

        events.emit('compile', {
          files: Object.keys(cache).filter(file => !startFiles.has(file)),
          duration: Date.now() - startTime
        });

        updateWatchedFiles(result.inputs);

        await writeFile(outputPath, result.bundle);
      } catch (e) {
        events.emit('error', e);

        addWatchedFiles(e.inputs);
      }

      const changedFiles = await waitForChange();
      changedFiles.forEach(file => delete cache[file]);
    }
  };

  run()
  .catch(error => {
    events.emit('error', error);
  });

  return events;

  function updateWatchedFiles(current) {
    const added = [];
    for (let file of current) {
      if (!watched.has(file))
        added.push(file);
    }

    const removed = [];
    for (let file of watched) {
      if (!current.has(file))
        removed.push(file);
    }

    watched = current;

    watcher.unwatch(removed);
    watcher.add(added);
  }

  function addWatchedFiles(files) {
    updateWatchedFiles(new Set([...watched, ...files]));
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

  function onChange(path) {
    changed.add(path);

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
}

function compile(entrypoint, cache, options) {
  return new Promise(function (resolve, reject) {
    const inputs = new Set([ entrypoint ]);

    const b = browserify(entrypoint, {
      basedir: process.cwd(),
      extensions: ['.js', '.json', '.cy', '.ts'],
      paths: [
        path.dirname(path.dirname(path.dirname(require.resolve('@babel/runtime-corejs2/package.json')))),
      ],
      builtins: fridaBuiltins,
      ignoreTransform: !options.babelify ? ['babelify'] : [],
      cache: cache,
      debug: options.sourcemap
    })
    .plugin(tsify)
    .on('package', function (pkg) {
      inputs.add(path.join(pkg.__dirname, 'package.json'));
    })
    .on('file', function (file) {
      inputs.add(file);
    })
    .transform(function (file) {
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

    if (options.babelify) {
      b.transform(babelify.configure({
        extensions: ['.js', '.cy', '.ts'],
        sourceMapsAbsolute: !!options.useAbsolutePaths
      }), {
        global: true,
        ignore: [/[\/\\]node_modules[\/\\](@babel|core-js|core-js-pure)[\/\\]/],
        presets: ['@babel/preset-env'],
        plugins: [
          [
            '@babel/plugin-transform-runtime',
            {
              corejs: 2
            }
          ]
        ]
      });
    } else {
      b.plugin(esmify)
    }

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

    b
    .bundle()
    .on('error', function (e) {
      e.inputs = inputs;
      reject(e);
    })
    .pipe(options.sourcemap ? mold.transform(trimSourceMap) : through.obj())
    .pipe(concat(function (buf) {
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
  compile,
  build,
  watch
};
