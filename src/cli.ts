#!/usr/bin/env node

import chalk from "chalk";
import type { ChalkInstance } from "chalk";
import { program, Option } from "commander";
import frida from "frida";

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { performance } from "node:perf_hooks";

const styleReset = chalk.reset;
const styleFile = chalk.cyan;
const styleLocation = chalk.yellow;
const styleCode = chalk.magenta;

const CATEGORY_STYLE: Record<string, ChalkInstance> = {
    Error: chalk.redBright,
    Warning: chalk.yellowBright,
    Info: chalk.blueBright,
    Suggestion: chalk.greenBright,
};

async function main() {
    program
        .usage("[options]")
        .argument("<module>", "TypeScript/JavaScript module to compile")
        .option("-o, --output <file>", "write output to <file>", "-")
        .option("-w, --watch", "watch for changes and recompile", false)
        .option("-S, --no-source-maps", "omit source-maps", false)
        .option("-c, --compress", "minify code", false)
        .option("-v, --verbose", "be verbose", false)
        .addOption(
            new Option(
                "-F, --output-format <format>",
                "desired output format"
            )
                .choices(["unescaped", "hex-bytes", "c-string"])
                .default("unescaped")
        )
        .addOption(
            new Option(
                "-B, --bundle-format <format>",
                "desired bundle format"
            )
                .choices(["esm", "iife"])
                .default("esm")
        )
        .addOption(
            new Option(
                "-T, --type-check <mode>",
                "desired type-checking mode"
            )
                .choices(["full", "none"])
                .default("full")
        );

    program.parse();

    const opts = program.opts<CLIOptions>();
    const projectRoot = process.cwd();
    const entrypoint = program.args[0];
    const outputPath = opts.output;
    const verbose = opts.watch || opts.verbose;

    const compilerOpts: frida.CompilerOptions = {
        projectRoot,
        outputFormat: opts.outputFormat,
        bundleFormat: opts.bundleFormat,
        typeCheck: opts.typeCheck,
        sourceMaps: opts.sourceMaps
            ? frida.SourceMaps.Included
            : frida.SourceMaps.Omitted,
        compression: opts.compress
            ? frida.JsCompression.Terser
            : frida.JsCompression.None,
    };

    const compiler = new frida.Compiler(frida.getDeviceManager());

    if (verbose) {
        let compilationStarted: number | null = null;

        compiler.starting.connect(() => {
            compilationStarted = performance.now();

            if (opts.watch) {
                readline.cursorTo(process.stdout, 0, 0);
                readline.clearScreenDown(process.stdout);
            }

            console.log(formatCompiling(entrypoint, projectRoot));
        });

        compiler.finished.connect(() => {
            const timeFinished = performance.now();

            console.log(
                formatCompiled(entrypoint, projectRoot, compilationStarted!, timeFinished)
            );
        });
    }

    compiler.output.connect((bundle: string) => {
        if (outputPath === "-") {
            process.stdout.write(bundle);
        } else {
            try {
                fs.writeFileSync(outputPath, bundle, {
                    encoding: "utf-8",
                });
            } catch (e) {
                console.error(chalk.redBright("Fatal Error:"), e);
                process.exit(1);
            }
        }
    });

    compiler.diagnostics.connect((diagnostics: Diagnostic[]) => {
        for (const diag of diagnostics) {
            console.log(formatDiagnostic(diag, projectRoot));
        }
    });

    if (opts.watch) {
        await compiler.watch(entrypoint, compilerOpts);

        // TODO: Add missing keepalive-customization in frida-node
        process.stdin.resume();
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        function shutdown() {
            process.stdin.pause();
        }
    } else {
        await compiler.build(entrypoint, compilerOpts);
    }
}

interface CLIOptions {
    output: string;
    watch: boolean;
    sourceMaps: boolean;
    compress: boolean;
    verbose: boolean;
    outputFormat: frida.OutputFormat;
    bundleFormat: frida.BundleFormat;
    typeCheck: frida.TypeCheckMode;
}

interface Diagnostic {
    category: string;
    code: number;
    text: string;
    file?: {
        path: string;
        line: number;
        character: number;
    };
}

function formatCompiling(scriptPath: string, cwd: string): string {
    const name = formatFilename(scriptPath, cwd);
    return (
        styleReset("") +
        "Compiling " +
        styleFile(name) +
        styleReset("") +
        "..."
    );
}

function formatCompiled(
    scriptPath: string,
    cwd: string,
    timeStarted: number,
    timeFinished: number
): string {
    const name = formatFilename(scriptPath, cwd);
    const elapsed = Math.floor(timeFinished - timeStarted);
    return (
        styleReset("") +
        "Compiled " +
        styleFile(name) +
        styleReset("") +
        styleCode(` (${elapsed} ms)`) +
        styleReset("")
    );
}

function formatDiagnostic(diag: Diagnostic, cwd: string): string {
    const { category, code, text, file } = diag;

    let prefix = "";
    if (file !== undefined) {
        const filename = formatFilename(file.path, cwd);
        const line = file.line + 1;
        const character = file.character + 1;

        const pathSegment = styleFile(filename);
        const lineSegment = styleLocation(String(line));
        const charSegment = styleLocation(String(character));

        prefix = `${pathSegment}:${lineSegment}:${charSegment} - `;
    }

    const categoryStyler = CATEGORY_STYLE[category] ?? styleReset;
    const styledCategory = categoryStyler(category);
    const styledCode = styleCode(`TS${code}`);

    return `${prefix}${styledCategory}${styleReset("")} ${styledCode}${styleReset("")}: ${text}`;
}

function formatFilename(filePath: string, cwd: string): string {
    const absoluteCwd = path.resolve(cwd);
    const absolutePath = path.resolve(filePath);

    if (absolutePath.startsWith(absoluteCwd + path.sep)) {
        return absolutePath.slice(absoluteCwd.length + 1);
    }

    return filePath;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
