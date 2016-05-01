'use strict';

const browserify = require('browserify');
const chokidar = require('chokidar');
const co = require('co');
const concat = require('concat-stream');
const EventEmitter = require('events');
const extend = require('extend');
const fs = require('fs');
const _mkdirp = require('mkdirp');
const mold = require('mold-source-map');
const path = require('path');
const through = require('through2');

function* build(inputPath, outputPath) {
  const result = yield compile(inputPath);
  yield mkdirp(path.dirname(outputPath));
  yield writeFile(outputPath, result.bundle);
  return result;
}

function watch(inputPath, outputPath) {
  const events = new EventEmitter();
  const cache = {};
  const watcher = chokidar.watch([], { persistent: true });
  let watched = new Set();
  const onChangeCallbacks = [];
  let changed = new Set();
  let lastChange = null;
  let timer = null;
  const ON_CHANGE_DELAY = 50;

  co(function* () {
    watcher.on('change', onChange);
    watcher.on('unlink', onChange);

    yield mkdirp(path.dirname(outputPath));

    while (true) {
      try {
        const startFiles = new Set(Object.keys(cache));
        const startTime = Date.now();

        const result = yield compile(inputPath, cache);

        events.emit('compile', {
          files: Object.keys(cache).filter(file => !startFiles.has(file)),
          duration: Date.now() - startTime
        });

        updateWatchedFiles(result.inputs);

        yield writeFile(outputPath, result.bundle);
      } catch (e) {
        events.emit('error', e);

        updateWatchedFiles(e.inputs);
      }

      const changedFiles = yield waitForChange();
      changedFiles.forEach(file => delete cache[file]);
    }
  })
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

function compile(entrypoint, cache) {
  cache = cache || {};

  return new Promise(function (resolve, reject) {
    const inputs = new Set();

    const b = browserify(entrypoint, {
      basedir: (path.extname(entrypoint) === '.js') ? path.dirname(entrypoint) : entrypoint,
      cache: cache,
      debug: true
    })
    .on('package', function (pkg) {
      inputs.add(path.join(pkg.__dirname, 'package.json'));
    })
    .on('file', function (file) {
      inputs.add(file);
    })
    .transform('babelify', {
      presets: ['es2015']
    });

    b.pipeline.get('deps').push(through.obj(function (row, enc, next) {
      const file = row.expose ? b._expose[row.id] : row.file;
      inputs.add(file);
      cache[file] = {
          source: row.source,
          deps: extend({}, row.deps)
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
    .pipe(mold.transform(trimSourceMap))
    .pipe(concat(function (buf) {
      resolve({
        bundle: buf,
        inputs: inputs
      });
    }));
  });
}

function mkdirp(dir, options) {
  return new Promise(function (resolve, reject) {
    _mkdirp(dir, options, err => {
      if (!err)
        resolve();
      else
        reject(err);
    });
  });
}

function writeFile(file, data, options) {
  return new Promise(function (resolve, reject) {
    fs.writeFile(file, data, options, err => {
      if (!err)
        resolve();
      else
        reject(err);
    });
  });
}

function trimSourceMap(molder) {
  var map = molder.sourcemap;
  map.setProperty('sourcesContent', undefined);
  return map.toComment();
}

module.exports = {
  build: co.wrap(build),
  watch: watch
};
