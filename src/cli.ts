#!/usr/bin/env node

import { program } from "commander";
import * as compiler from "./compiler.js";

async function main() {
    program
        .usage("[options] <module>")
        .requiredOption("-o, --output <file>", "write output to <file>")
        .option("-w, --watch", "watch for changes and recompile")
        .option("-S, --no-source-maps", "omit source-maps")
        .option("-c, --compress", "compress using terser");

    program.parse();

    const opts = program.opts();
    const compilerOpts: compiler.Options = {
        projectRoot: process.cwd(),
        inputPath: program.args[0],
        outputPath: opts.output,
        sourceMaps: opts.sourceMaps ? "included" : "omitted",
        compression: opts.compress ? "terser" : "none",
    };

    if (opts.watch) {
        await compiler.watch(compilerOpts);
    } else {
        await compiler.build(compilerOpts);
    }
}

main()
    .catch(e => {
        console.error(e);
        process.exitCode = 1;
    });