import { Buffer } from "buffer";
import { cjsToEsmTransformer } from "../ext/cjstoesm.js";
import EventEmitter from "events";
import fsPath from "path";
import process from "process";
import { check as checkIdentifier } from "@frida/reserved-words";
import { minify, MinifyOptions, SourceMapOptions } from "terser";
import TypedEmitter from "typed-emitter";
import ts from "../ext/typescript.js";

const isWindows = process.platform === "win32";
const compilerRoot = detectCompilerRoot();

const sourceTransformers: ts.CustomTransformers = {
    after: [
        useStrictRemovalTransformer(),
    ]
};

export async function build(options: BuildOptions): Promise<string> {
    const entrypoint = deriveEntrypoint(options);
    const outputOptions = makeOutputOptions(options);
    const { projectRoot, assets, system, onDiagnostic } = options;

    const compilerOpts = makeCompilerOptions(projectRoot, system, outputOptions);
    const compilerHost = ts.createIncrementalCompilerHost(compilerOpts, system);

    const program = ts.createProgram({
        rootNames: [entrypoint.input],
        options: compilerOpts,
        host: compilerHost
    });
    const preEmitDiagnostics = ts.getPreEmitDiagnostics(program);
    if (onDiagnostic !== undefined) {
        for (const diagnostic of preEmitDiagnostics) {
            onDiagnostic(diagnostic);
        }
    }
    if (preEmitDiagnostics.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
        throw new Error("compilation failed");
    }

    const bundler = createBundler(entrypoint, projectRoot, assets, system, outputOptions);

    const emitResult = program.emit(undefined, undefined, undefined, undefined, sourceTransformers);
    if (onDiagnostic !== undefined) {
        for (const diagnostic of emitResult.diagnostics) {
            onDiagnostic(diagnostic);
        }
    }
    if (emitResult.emitSkipped || emitResult.diagnostics.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
        throw new Error("compilation failed");
    }

    return await bundler.bundle(program);
}

export function watch(options: WatchOptions): TypedEmitter<WatcherEvents> {
    const entrypoint = deriveEntrypoint(options);
    const outputOptions = makeOutputOptions(options);
    const { projectRoot, assets, system } = options;

    const events = new EventEmitter() as TypedEmitter<WatcherEvents>;

    const origCreateProgram: any = ts.createEmitAndSemanticDiagnosticsBuilderProgram;
    const createProgram: ts.CreateProgram<ts.EmitAndSemanticDiagnosticsBuilderProgram> = (...args: any[]): ts.EmitAndSemanticDiagnosticsBuilderProgram => {
        const program: ts.EmitAndSemanticDiagnosticsBuilderProgram = origCreateProgram(...args);

        const origEmit = program.emit;
        program.emit = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
            return origEmit(targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, sourceTransformers);
        };

        return program;
    };

    const compilerOpts = makeCompilerOptions(projectRoot, system, outputOptions);
    const compilerHost = ts.createWatchCompilerHost([entrypoint.input], compilerOpts, system, createProgram);

    let state: "dirty" | "clean" = "dirty";
    let pending: Promise<void> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const bundler = createBundler(entrypoint, projectRoot, assets, system, outputOptions);
    bundler.events.on("externalSourceFileAdded", file => {
        compilerHost.watchFile(file.fileName, () => {
            state = "dirty";
            bundler.invalidate(portablePathToFilePath(file.fileName));
            if (pending !== null || timer !== null) {
                return;
            }
            timer = setTimeout(() => {
                timer = null;
                rebundle();
            }, 250);
        });
    });

    const origPostProgramCreate = compilerHost.afterProgramCreate!;
    compilerHost.afterProgramCreate = async program => {
        origPostProgramCreate(program);
        process.nextTick(rebundle);
    };

    const watchProgram = ts.createWatchProgram(compilerHost);

    function rebundle(): void {
        if (pending === null) {
            state = "clean";
            pending = performBundling();
            pending.then(() => {
                pending = null;
                if (state === "dirty") {
                    rebundle();
                }
            });
        } else {
            state = "dirty";
        }
    }

    async function performBundling(): Promise<void> {
        try {
            const bundle = await bundler.bundle(watchProgram.getProgram().getProgram());
            events.emit("bundleUpdated", bundle);
        } catch (e) {
            console.error("Failed to bundle:", e);
        }
    }

    return events;
}

export interface Options {
    projectRoot: string;
    entrypoint: string;
    assets: Assets;
    system: ts.System;
    sourceMaps?: SourceMaps;
    compression?: Compression;
}

export interface BuildOptions extends Options {
    onDiagnostic?(diagnostic: ts.Diagnostic): void;
}

export interface WatchOptions extends Options {
}

export type SourceMaps = "included" | "omitted";
export type Compression = "none" | "terser";

export interface Assets {
    projectNodeModulesDir: string;
    compilerNodeModulesDir: string;
    shimDir: string;
    shims: Map<string, string>;
}

export type WatcherEvents = {
    bundleUpdated: (bundle: string) => void,
};

interface EntrypointName {
    input: string;
    output: string;
}

interface OutputOptions {
    sourceMaps: SourceMaps;
    compression: Compression;
}

type ModuleType = "cjs" | "esm";

interface JSModule {
    type: ModuleType;
    path: string;
    file: ts.SourceFile;
    aliases: Set<string>;
}

interface ModuleReference {
    name: string;
    referrer: JSModule;
}

function deriveEntrypoint(options: Options): EntrypointName {
    const { projectRoot, entrypoint } = options;

    const input = fsPath.isAbsolute(entrypoint) ? entrypoint : fsPath.join(projectRoot, entrypoint);
    if (!input.startsWith(projectRoot)) {
        throw new Error("entrypoint must be inside the project root");
    }

    let output = input.substring(projectRoot.length);
    if (output.endsWith(".ts")) {
        output = output.substring(0, output.length - 2) + "js";
    }

    return { input, output };
}

function makeOutputOptions(options: Options): OutputOptions {
    const {
        sourceMaps = "included",
        compression = "none",
    } = options;

    return { sourceMaps, compression };
}

export function queryDefaultAssets(projectRoot: string, sys: ts.System): Assets {
    const projectNodeModulesDir = fsPath.join(projectRoot, "node_modules");
    const compilerNodeModulesDir = fsPath.join(compilerRoot, "node_modules");
    const shimDir = sys.directoryExists(compilerNodeModulesDir) ? compilerNodeModulesDir : projectNodeModulesDir;

    const shims = new Map([
        ["assert", fsPath.join(shimDir, "@frida", "assert")],
        ["base64-js", fsPath.join(shimDir, "@frida", "base64-js")],
        ["buffer", fsPath.join(shimDir, "@frida", "buffer")],
        ["diagnostics_channel", fsPath.join(shimDir, "@frida", "diagnostics_channel")],
        ["events", fsPath.join(shimDir, "@frida", "events")],
        ["fs", fsPath.join(shimDir, "frida-fs")],
        ["http", fsPath.join(shimDir, "@frida", "http")],
        ["https", fsPath.join(shimDir, "@frida", "https")],
        ["http-parser-js", fsPath.join(shimDir, "@frida", "http-parser-js")],
        ["ieee754", fsPath.join(shimDir, "@frida", "ieee754")],
        ["net", fsPath.join(shimDir, "@frida", "net")],
        ["os", fsPath.join(shimDir, "@frida", "os")],
        ["path", fsPath.join(shimDir, "@frida", "path")],
        ["process", fsPath.join(shimDir, "@frida", "process")],
        ["punycode", fsPath.join(shimDir, "@frida", "punycode")],
        ["querystring", fsPath.join(shimDir, "@frida", "querystring")],
        ["readable-stream", fsPath.join(shimDir, "@frida", "readable-stream")],
        ["stream", fsPath.join(shimDir, "@frida", "stream")],
        ["string_decoder", fsPath.join(shimDir, "@frida", "string_decoder")],
        ["timers", fsPath.join(shimDir, "@frida", "timers")],
        ["tty", fsPath.join(shimDir, "@frida", "tty")],
        ["url", fsPath.join(shimDir, "@frida", "url")],
        ["util", fsPath.join(shimDir, "@frida", "util")],
        ["vm", fsPath.join(shimDir, "@frida", "vm")],
    ]);

    const nodeShimNames = [
        "assert",
        "buffer",
        "diagnostics_channel",
        "events",
        "fs",
        "http",
        "https",
        "net",
        "os",
        "path",
        "process",
        "punycode",
        "querystring",
        "stream",
        "string_decoder",
        "timers",
        "tty",
        "url",
        "util",
        "vm",
    ];
    for (const name of nodeShimNames) {
        const path = shims.get(name)!;
        shims.set("node:" + name, path);
    }

    return {
        projectNodeModulesDir,
        compilerNodeModulesDir,
        shimDir,
        shims,
    };
}

function makeCompilerOptions(projectRoot: string, system: ts.System, options: OutputOptions): ts.CompilerOptions {
    const defaultTsOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        lib: ["lib.es2020.d.ts"],
        module: ts.ModuleKind.ES2020,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        allowJs: true,
        strict: true
    };

    const configFileHost = new FridaConfigFileHost(projectRoot, system);

    const opts = ts.getParsedCommandLineOfConfigFile(fsPath.join(projectRoot, "tsconfig.json"), defaultTsOptions, configFileHost)?.options ?? defaultTsOptions;
    delete opts.noEmit;
    opts.rootDir = projectRoot;
    opts.outDir = "/";
    if (options.sourceMaps === "included") {
        opts.sourceRoot = projectRoot;
        opts.sourceMap = true;
        opts.inlineSourceMap = false;
    }
    return opts;
}

function createBundler(entrypoint: EntrypointName, projectRoot: string, assets: Assets, system: ts.System, options: OutputOptions): Bundler {
    const {
        sourceMaps,
        compression,
    } = options;

    const events = new EventEmitter() as TypedEmitter<BundlerEvents>;

    const output = new Map<string, string>();
    const pendingModules: ModuleReference[] = [];
    const processedModules = new Set<string>();
    const jsonFilePaths = new Set<string>();
    const modules = new Map<string, JSModule>();
    const externalSources = new Map<string, ts.SourceFile>();

    system.writeFile = (path, data, writeByteOrderMark) => {
        output.set(path, data);
    };

    function markAllProgramSourcesAsProcessed(program: ts.Program): void {
        for (const sf of program.getSourceFiles()) {
            if (!sf.isDeclarationFile) {
                const outPath = changeFileExtension(portablePathToFilePath(sf.fileName), "js");
                processedModules.add(outPath);
            }
        }
    }

    function getExternalSourceFile(path: string): ts.SourceFile {
        let file = externalSources.get(path);
        if (file !== undefined) {
            return file;
        }

        const sourceText = system.readFile(path, "utf-8");
        if (sourceText === undefined) {
            throw new Error(`unable to open ${path}`);
        }

        file = ts.createSourceFile(path, sourceText, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
        externalSources.set(path, file);

        events.emit("externalSourceFileAdded", file);

        return file;
    }

    function assetNameFromFilePath(path: string): string {
        if (path.startsWith(compilerRoot)) {
            return portablePathFromFilePath(path.substring(compilerRoot.length));
        }

        if (path.startsWith(projectRoot)) {
            return portablePathFromFilePath(path.substring(projectRoot.length));
        }

        throw new Error(`unexpected file path: ${path}`);
    }

    return {
        events,
        async bundle(program: ts.Program): Promise<string> {
            markAllProgramSourcesAsProcessed(program);

            for (const sf of program.getSourceFiles()) {
                if (!sf.isDeclarationFile) {
                    const { fileName } = sf;
                    const path = changeFileExtension(portablePathToFilePath(fileName), "js");
                    const mod: JSModule = {
                        type: "esm",
                        path,
                        file: sf,
                        aliases: new Set<string>(),
                    };
                    modules.set(assetNameFromFilePath(path), mod);

                    processJSModule(mod, processedModules, pendingModules, jsonFilePaths);
                }
            }

            const missing = new Set<string>();
            let ref: ModuleReference | undefined;
            while ((ref = pendingModules.shift()) !== undefined) {
                const refName = ref.name;
                processedModules.add(ref.name);

                let resolveRes: ResolveModuleReferenceResult;
                try {
                    resolveRes = resolveModuleReference(ref, assets, system);
                } catch (e) {
                    missing.add(refName);
                    continue;
                }
                const [modPath, needsAlias] = resolveRes;

                const assetName = assetNameFromFilePath(modPath);

                let mod = modules.get(assetName);
                if (mod === undefined) {
                    const sourceFile = getExternalSourceFile(modPath);
                    mod = {
                        type: detectModuleType(modPath, system),
                        path: modPath,
                        file: sourceFile,
                        aliases: new Set<string>(),
                    };
                    output.set(assetName, sourceFile.text);
                    modules.set(assetName, mod);
                    processedModules.add(modPath);

                    processJSModule(mod, processedModules, pendingModules, jsonFilePaths);
                }

                if (needsAlias) {
                    mod.aliases.add(refName);
                }
            }
            if (missing.size > 0) {
                throw new Error(`unable to resolve: ${Array.from(missing).join(", ")}`);
            }

            const legacyModules = Array.from(modules.values()).filter(m => m.type === "cjs");
            if (legacyModules.length > 0) {
                const opts = makeCompilerOptions(projectRoot, system, options);
                const host = ts.createIncrementalCompilerHost(opts, system);
                const p = ts.createProgram({
                    rootNames: legacyModules.map(m => m.path),
                    options: { ...opts, allowJs: true },
                    host
                });
                p.emit(undefined, undefined, undefined, undefined, {
                    before: [
                        cjsToEsmTransformer()
                    ],
                    after: [
                        useStrictRemovalTransformer()
                    ]
                });
            }

            for (const path of jsonFilePaths) {
                const assetName = assetNameFromFilePath(path);
                if (!output.has(assetName)) {
                    output.set(assetName, system.readFile(path)!);
                }
            }

            for (const [name, data] of output) {
                if (name.endsWith(".js")) {
                    let code = data;

                    const lines = code.split("\n");
                    const n = lines.length;
                    const lastLine = lines[n - 1];
                    if (lastLine.startsWith("//# sourceMappingURL=")) {
                        const precedingLines = lines.slice(0, n - 1);
                        code = precedingLines.join("\n");
                    }

                    if (compression === "terser") {
                        const mod = modules.get(name)!;
                        const originPath = mod.path;
                        const originFilename = fsPath.basename(originPath);

                        const minifySources: { [name: string]: string } = {};
                        minifySources[originFilename] = code;

                        const minifyOpts: MinifyOptions = {
                            ecma: 2020,
                            compress: {
                                module: true,
                                global_defs: {
                                    "process.env.FRIDA_COMPILE": true
                                },
                            },
                            mangle: {
                                module: true,
                            },
                        };

                        const mapName = name + ".map";

                        if (sourceMaps === "included") {
                            const mapOpts: SourceMapOptions = {
                                asObject: true,
                                root: portablePathFromFilePath(fsPath.dirname(originPath)) + "/",
                                filename: name.substring(name.lastIndexOf("/") + 1),
                            } as SourceMapOptions;

                            const inputMap = output.get(mapName);
                            if (inputMap !== undefined) {
                                mapOpts.content = inputMap;
                            }

                            minifyOpts.sourceMap = mapOpts;
                        }

                        const result = await minify(minifySources, minifyOpts);
                        code = result.code!;

                        if (sourceMaps === "included") {
                            const map = result.map as { [key: string]: any };
                            const prefixLength: number = map.sourceRoot.length;
                            map.sources = map.sources.map((s: string) => s.substring(prefixLength));
                            output.set(mapName, JSON.stringify(map));
                        }
                    }

                    output.set(name, code);
                } else if (name.endsWith(".json")) {
                    output.set(name, jsonToModule(data));
                }
            }

            const names: string[] = [];

            const orderedNames = Array.from(output.keys());
            orderedNames.sort();

            const maps = new Set(orderedNames.filter(name => name.endsWith(".map")));
            const entrypointNormalized = fsPath.normalize(entrypoint.output);
            for (const name of orderedNames.filter(name => !name.endsWith(".map"))) {
                let index = (fsPath.normalize(name) === entrypointNormalized) ? 0 : names.length;

                const mapName = name + ".map";
                if (maps.has(mapName)) {
                    names.splice(index, 0, mapName);
                    index++;
                }

                names.splice(index, 0, name);
            }

            const chunks: string[] = [];
            chunks.push("📦\n")
            for (const name of names) {
                const rawData = Buffer.from(output.get(name)!);
                chunks.push(`${rawData.length} ${name}\n`);
                const mod = modules.get(name);
                if (mod !== undefined) {
                    for (const alias of mod.aliases) {
                        chunks.push(`↻ ${alias}\n`)
                    }
                }
            }
            chunks.push("✄\n");
            let i = 0;
            for (const name of names) {
                if (i !== 0) {
                    chunks.push("\n✄\n");
                }
                const data = output.get(name)!;
                chunks.push(data);
                i++;
            }

            return chunks.join("");
        },
        invalidate(path: string): void {
            output.delete(assetNameFromFilePath(path));
            processedModules.clear();
            externalSources.delete(path);
        }
    };
}

interface Bundler {
    events: TypedEmitter<BundlerEvents>;

    bundle(program: ts.Program): Promise<string>;
    invalidate(path: string): void;
}

type BundlerEvents = {
    externalSourceFileAdded: (file: ts.SourceFile) => void,
};

function detectModuleType(modPath: string, sys: ts.System): ModuleType {
    let curDir = fsPath.dirname(modPath);
    while (true) {
        const rawPkgMeta = sys.readFile(fsPath.join(curDir, "package.json"));
        if (rawPkgMeta !== undefined) {
            const pkgMeta = JSON.parse(rawPkgMeta);
            if (pkgMeta.type === "module" || pkgMeta.module !== undefined) {
                return "esm";
            }
            break;
        }

        const nextDir = fsPath.dirname(curDir);
        if (nextDir === curDir) {
            break;
        }
        curDir = nextDir;
    }

    return "cjs";
}

type ResolveModuleReferenceResult = [path: string, needsAlias: boolean];

function resolveModuleReference(ref: ModuleReference, assets: Assets, system: ts.System): ResolveModuleReferenceResult {
    const refName = ref.name;
    const requesterPath = ref.referrer.path;

    let modPath: string;
    let needsAlias = false;
    if (fsPath.isAbsolute(refName)) {
        modPath = refName;
    } else {
        const tokens = refName.split("/");

        let pkgName: string;
        let subPath: string[];
        if (tokens[0].startsWith("@")) {
            pkgName = tokens[0] + "/" + tokens[1];
            subPath = tokens.slice(2);
        } else {
            pkgName = tokens[0];
            subPath = tokens.slice(1);
        }

        const shimPath = assets.shims.get(pkgName);
        if (shimPath !== undefined) {
            if (shimPath.endsWith(".js")) {
                modPath = shimPath;
            } else {
                modPath = fsPath.join(shimPath, ...subPath);
            }
            needsAlias = true;
        } else {
            const linkedCompilerRoot = fsPath.join(assets.projectNodeModulesDir, "frida-compile");
            if (requesterPath.startsWith(compilerRoot) || requesterPath.startsWith(linkedCompilerRoot)) {
                modPath = fsPath.join(assets.shimDir, ...tokens);
            } else {
                modPath = fsPath.join(assets.projectNodeModulesDir, ...tokens);
            }
            needsAlias = subPath.length > 0;
        }
    }

    if (system.directoryExists(modPath)) {
        const rawPkgMeta = system.readFile(fsPath.join(modPath, "package.json"));
        if (rawPkgMeta !== undefined) {
            const pkgMeta = JSON.parse(rawPkgMeta);
            const pkgMain = pkgMeta.module ?? pkgMeta.main ?? "index.js";
            let pkgEntrypoint = fsPath.join(modPath, pkgMain);
            if (system.directoryExists(pkgEntrypoint)) {
                pkgEntrypoint = fsPath.join(pkgEntrypoint, "index.js");
            }

            modPath = pkgEntrypoint;
            needsAlias = true;
        } else {
            modPath = fsPath.join(modPath, "index.js");
        }
    }

    if (!system.fileExists(modPath)) {
        modPath += ".js";
        if (!system.fileExists(modPath)) {
            throw new Error("unable to resolve module");
        }
    }

    return [modPath, needsAlias];
}

function processJSModule(mod: JSModule, processedModules: Set<string>, pendingModules: ModuleReference[], jsonFilePaths: Set<string>): void {
    const moduleDir = fsPath.dirname(mod.path);
    const isCJS = mod.type === "cjs";
    ts.forEachChild(mod.file, visit);

    function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) {
            visitImportDeclaration(node);
        } else if (ts.isExportDeclaration(node)) {
            visitExportDeclaration(node);
        } else if (isCJS && ts.isCallExpression(node)) {
            visitCallExpression(node);
            ts.forEachChild(node, visit);
        } else {
            ts.forEachChild(node, visit);
        }
    }

    function visitImportDeclaration(imp: ts.ImportDeclaration) {
        const depName = (imp.moduleSpecifier as ts.StringLiteral).text;
        maybeAddModuleToPending(depName);
    }

    function visitExportDeclaration(exp: ts.ExportDeclaration) {
        const specifier = exp.moduleSpecifier;
        if (specifier === undefined) {
            return;
        }

        const depName = (specifier as ts.StringLiteral).text;
        maybeAddModuleToPending(depName);
    }

    function visitCallExpression(call: ts.CallExpression) {
        const expr: ts.LeftHandSideExpression = call.expression;
        if (!ts.isIdentifier(expr)) {
            return;
        }
        if (expr.escapedText !== "require") {
            return;
        }

        const args = call.arguments;
        if (args.length !== 1) {
            return;
        }

        const arg = args[0];
        if (!ts.isStringLiteral(arg)) {
            return;
        }

        const depName = arg.text;
        maybeAddModuleToPending(depName);
    }

    function maybeAddModuleToPending(name: string) {
        const ref = name.startsWith(".") ? fsPath.join(moduleDir, name) : name;
        if (name.endsWith(".json")) {
            jsonFilePaths.add(ref);
        } else if (!processedModules.has(ref)) {
            pendingModules.push({ name: ref, referrer: mod });
        }
    }
}

function useStrictRemovalTransformer(): ts.TransformerFactory<ts.SourceFile> {
    return context => {
        return sourceFile => {
            const visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
                if (ts.isExpressionStatement(node)) {
                    const { expression } = node;
                    if (ts.isStringLiteral(expression) && expression.text === "use strict") {
                        return [];
                    }
                }

                return ts.visitEachChild(node, visitor, context);
            };

            return ts.visitNode(sourceFile, visitor);
        };
    };
}

function jsonToModule(json: string): string {
    const result: string[] = [];

    const data = JSON.parse(json);
    if (typeof data === "object" && data !== null) {
        const obj: [string, any] = data;

        let identifier = "d";
        let candidate = identifier;
        let serial = 1;
        while (obj.hasOwnProperty(candidate)) {
            candidate = identifier + serial;
            serial++;
        }
        identifier = candidate;

        result.push(`const ${identifier} = ${json.trim()};`);

        result.push(`export default ${identifier};`);

        for (const member of Object.keys(data).filter(identifier => !checkIdentifier(identifier, "es2015", true))) {
            result.push(`export const ${member} = ${identifier}.${member};`);
        }
    } else {
        result.push(`export default ${json.trim()};`);
    }

    return result.join("\n");
}

class FridaConfigFileHost implements ts.ParseConfigFileHost {
    useCaseSensitiveFileNames = true;

    constructor(
        private projectRoot: string,
        private sys: ts.System,
    ) {
    }

    readDirectory(rootDir: string, extensions: readonly string[], excludes: readonly string[] | undefined, includes: readonly string[], depth?: number): readonly string[] {
        return this.sys.readDirectory(rootDir, extensions, excludes, includes, depth);
    }

    fileExists(path: string): boolean {
        return this.sys.fileExists(path);
    }

    readFile(path: string): string | undefined {
        return this.sys.readFile(path);
    }

    trace?(s: string): void {
        console.log(s);
    }

    getCurrentDirectory(): string {
        return this.projectRoot;
    }

    onUnRecoverableConfigFileDiagnostic(diagnostic: ts.Diagnostic) {
    }
}

function detectCompilerRoot(): string {
    if (process.env.FRIDA_COMPILE !== undefined) {
        return fsPath.sep + "frida-compile";
    } else {
        const jsPath = import.meta.url.substring(isWindows ? 8 : 7);
        const rootPath = fsPath.dirname(fsPath.dirname(jsPath));
        return portablePathToFilePath(rootPath);
    }
}

function portablePathFromFilePath(path: string): string {
    return isWindows ? path.replace(/\\/g, "/") : path;
}

function portablePathToFilePath(path: string): string {
    return isWindows ? path.replace(/\//g, "\\") : path;
}

function changeFileExtension(path: string, ext: string): string {
    const pathWithoutExtension = path.substring(0, path.lastIndexOf("."));
    return pathWithoutExtension + "." + ext;
}
