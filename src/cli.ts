#!/usr/bin/env node

import { program } from "commander";
import * as compiler from "./compiler.js";
import fs from "fs";
import fsPath from "path";
import { getNodeSystem } from "./system/node.js";
import ts from "../ext/typescript.js";

function main() {
    program
        .usage("[options] <module>")
        .requiredOption("-o, --output <file>", "write output to <file>")
        .option("-w, --watch", "watch for changes and recompile")
        .option("-S, --no-source-maps", "omit source-maps")
        .option("-c, --compress", "compress using terser");

    program.parse();

    const opts = program.opts();
    const projectRoot: string = process.cwd();
    const entrypoint: string = program.args[0];
    const outputPath: string = opts.output;

    const fullOutputPath = fsPath.isAbsolute(outputPath) ? outputPath : fsPath.join(projectRoot, outputPath);
    const outputDir = fsPath.dirname(fullOutputPath);

    const system = getNodeSystem();
    const assets = compiler.queryDefaultAssets(projectRoot, system);

    const compilerOpts: compiler.Options = {
        projectRoot,
        entrypoint,
        sourceMaps: opts.sourceMaps ? "included" : "omitted",
        compression: opts.compress ? "terser" : "none",
        assets,
        system
    };

    if (opts.watch) {
        compiler.watch(compilerOpts)
            .on("bundleUpdated", writeBundle);
    } else {
        const bundle = compiler.build({
            ...compilerOpts, onDiagnostic({
                file,
                start,
                messageText
            }) {
                if (file !== undefined) {
                    const { line, character } = ts.getLineAndCharacterOfPosition(file, start!);
                    const message = ts.flattenDiagnosticMessageText(messageText, "\n");
                    console.log(`${file.fileName} (${line + 1},${character + 1}): ${message}`);
                } else {
                    console.log(ts.flattenDiagnosticMessageText(messageText, "\n"));
                }
            }
        });
        writeBundle(bundle);
    }

    function writeBundle(bundle: string): void {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(fullOutputPath, bundle!);
    }
}

try {
    main();
} catch (e) {
    console.error(e);
    process.exitCode = 1;
}
