#!/usr/bin/env node
const chalk = require('chalk');
const compiler = require('..');
const notifier = require('node-notifier');
const path = require('path');
const program = require('commander');
const version = require('../package.json').version;

program
    .version(version)
    .usage('[options] <module>')
    .option('-o, --output <file>', 'set output <file>')
    .option('-w, --watch', 'watch for changes and recompile')
    .option('-b, --bytecode', 'output bytecode')
    .option('-x, --no-babelify', 'skip Babel transforms')
    .option('-X, --no-esmify', 'used with -x to also skip esmify transforms')
    .option('-L, --loose', 'enable loose Babel transformations')
    .option('-S, --no-sourcemap', 'omit sourcemap')
    .option('-c, --compress', 'compress using UglifyJS2')
    .option('-a, --use-absolute-paths', 'use absolute source paths')
    .parse(process.argv);

const inputModule = program.args[0];
const outputPath = program.output;
const watch = !!program.watch;
if (!inputModule || !outputPath)
  program.help();
const inputPath = require.resolve(path.resolve(process.cwd(), inputModule));
const options = {
  target: program.target,
  bytecode: !!program.bytecode,
  babelify: program.babelify,
  esmify: program.esmify,
  loose: program.loose,
  sourcemap: program.sourcemap,
  compress: !!program.compress,
  useAbsolutePaths: !!program.useAbsolutePaths
};

if (!watch) {
  compiler.build(inputPath, outputPath, options)
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  compiler.watch(inputPath, outputPath, options)
  .on('compile', details => {
    const count = details.files.length;
    const duration = details.duration;

    console.log('Compiled', count, 'file' + ((count === 1) ? '' : 's'), chalk.yellow('(' + duration + ' ms)'));
  })
  .on('error', error => {
    const message = error.toString();

    console.error(chalk.red('Compilation failed:'), message);

    notifier.notify({
      title: 'Compilation failed',
      message: message
    });
  });
}
