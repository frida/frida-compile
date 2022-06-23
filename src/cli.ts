#!/usr/bin/env node

import { program } from "commander";
import { build } from "./index.js";

async function main() {
    program
    .usage("[options] <module>")
    .requiredOption("-o, --output <file>", "write output to <file>")
    .option("-S, --no-source-maps", "omit source-maps")
    .option("-c, --compress", "compress using terser");

    program.parse();

    const opts = program.opts();
    console.log("opts:", opts);

    await build({
        projectRoot: process.cwd(),
        inputPath: program.args[0],
        outputPath: opts.output,
        sourceMaps: opts.sourceMaps ? "included" : "omitted",
        compression: opts.compress ? "terser" : "none",
    });
}

main()
    .catch(e => {
        console.error(e);
        process.exitCode = 1;
    });