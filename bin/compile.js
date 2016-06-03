#!/usr/bin/env node
'use strict';

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
    .parse(process.argv);

const inputModule = program.args[0];
const outputPath = program.output;
const watch = !!program.watch;
if (!inputModule || !outputPath)
  program.help();
const inputPath = require.resolve(path.resolve(process.cwd(), inputModule));
const options = {
  bytecode: !!program.bytecode
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
