import { cjsToEsmTransformer } from "../ext/cjstoesm.js";
import EventEmitter from "events";
import fsPath from "path";
import process from "process";
import { FridaSystem } from "./system/frida.js";
import { getNodeSystem } from "./system/node.js";
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

export async function build(options: Options): Promise<void> {
    const entrypoint = deriveEntrypoint(options);

    const sys = makeSystem(options);
    const assets = getAssets(sys, options);

    const compilerOpts = makeCompilerOptions(sys, options);
    const compilerHost = ts.createIncrementalCompilerHost(compilerOpts, sys);

    const program = ts.createProgram({
        rootNames: [entrypoint.input],
        options: compilerOpts,
        host: compilerHost
    });

    const bundler = createBundler(entrypoint, assets, sys, options);

    program.emit(undefined, undefined, undefined, undefined, sourceTransformers);

    await bundler.bundle(program);
}

export function watch(options: Options): void {
    const entrypoint = deriveEntrypoint(options);

    const sys = makeSystem(options);
    const assets = getAssets(sys, options);

    const origCreateProgram: any = ts.createEmitAndSemanticDiagnosticsBuilderProgram;
    const createProgram: ts.CreateProgram<ts.EmitAndSemanticDiagnosticsBuilderProgram> = (...args: any[]): ts.EmitAndSemanticDiagnosticsBuilderProgram => {
        const program: ts.EmitAndSemanticDiagnosticsBuilderProgram = origCreateProgram(...args);

        const origEmit = program.emit;
        program.emit = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
            return origEmit(targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, sourceTransformers);
        };

        return program;
    };

    const compilerOpts = makeCompilerOptions(sys, options);
    const compilerHost = ts.createWatchCompilerHost([entrypoint.input], compilerOpts, sys, createProgram);

    let state: "dirty" | "clean" = "dirty";
    let pending: Promise<void> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const bundler = createBundler(entrypoint, assets, sys, options);
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
            await bundler.bundle(watchProgram.getProgram().getProgram());
        } catch (e) {
            console.error("Failed to bundle:", e);
        }
    }
}

export interface Options {
    projectRoot: string;
    inputPath: string;
    outputPath: string;
    sourceMaps?: "included" | "omitted";
    compression?: "none" | "terser";
}

type ModuleType = "cjs" | "esm";

interface JSModule {
    type: ModuleType;
    path: string;
    file: ts.SourceFile;
}

function makeCompilerOptions(system: ts.System, options: Options): ts.CompilerOptions {
    const { projectRoot } = options;

    const defaultTsOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        resolveJsonModule: true,
        allowJs: true,
        strict: true
    };

    const configFileHost = new FridaConfigFileHost(projectRoot, system);

    const opts = ts.getParsedCommandLineOfConfigFile(fsPath.join(projectRoot, "tsconfig.json"), defaultTsOptions, configFileHost)?.options ?? defaultTsOptions;
    delete opts.noEmit;
    opts.rootDir = projectRoot;
    opts.outDir = "/";
    opts.sourceRoot = projectRoot;
    if (options.sourceMaps === "included") {
        opts.sourceMap = true;
        opts.inlineSourceMap = false;
    }
    return opts;
}

function createBundler(entrypoint: EntrypointName, assets: Assets, sys: ts.System, options: Options): Bundler {
    const {
        projectRoot,
        outputPath,
        sourceMaps = "included",
        compression = "none",
    } = options;

    const events = new EventEmitter() as TypedEmitter<BundlerEvents>;

    const output = new Map<string, string>();
    const origins = new Map<string, string>();
    const aliases = new Map<string, string>();
    const pendingModules = new Map<string, JSModule>();
    const processedModules = new Set<string>();
    const jsonFilePaths = new Set<string>();
    const modules = new Map<string, JSModule>();
    const externalSources = new Map<string, ts.SourceFile>();

    const origWriteFile = sys.writeFile;
    sys.writeFile = (path, data, writeByteOrderMark) => {
        output.set(path, data);
    };

    function getExternalSourceFile(path: string): ts.SourceFile {
        let file = externalSources.get(path);
        if (file !== undefined) {
            return file;
        }

        const sourceText = sys.readFile(path, "utf-8");
        if (sourceText === undefined) {
            throw new Error(`Unable to open ${path}`);
        }

        file = ts.createSourceFile(path, sourceText, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
        externalSources.set(path, file);

        events.emit("externalSourceFileAdded", file);

        return file;
    }

    function assetNameFromFilePath(path: string): string {
        const { shimDir } = assets;

        if (path.startsWith(shimDir)) {
            return "/shims" + portablePathFromFilePath(path.substring(shimDir.length));
        }

        if (path.startsWith(compilerRoot)) {
            return portablePathFromFilePath(path.substring(compilerRoot.length));
        }

        if (path.startsWith(projectRoot)) {
            return portablePathFromFilePath(path.substring(projectRoot.length));
        }

        throw new Error(`Unexpected file path: ${path}`);
    }

    return {
        events,
        async bundle(program: ts.Program): Promise<void> {
            for (const sf of program.getSourceFiles()) {
                if (!sf.isDeclarationFile) {
                    const fileName = portablePathToFilePath(sf.fileName);
                    const bareName = fileName.substring(0, fileName.lastIndexOf("."));
                    const outName = bareName + ".js";
                    origins.set(assetNameFromFilePath(outName), outName);
                    processedModules.add(bareName);
                    processedModules.add(outName);
                }
            }

            for (const sf of program.getSourceFiles()) {
                if (!sf.isDeclarationFile) {
                    const { fileName } = sf;
                    const mod: JSModule = {
                        type: "esm",
                        path: portablePathToFilePath(fileName),
                        file: sf
                    };
                    processJSModule(mod, processedModules, pendingModules, jsonFilePaths);
                }
            }

            const compilerNodeSystemSuffix = fsPath.join("frida-compile", "dist", "system", "node.js");
            const linkedCompilerRoot = fsPath.join(assets.projectNodeModulesDir, "frida-compile");

            while (pendingModules.size > 0) {
                const entry: string = pendingModules.keys().next().value;
                const requesterPath = pendingModules.get(entry)!.path;
                pendingModules.delete(entry);
                processedModules.add(entry);

                if (entry.endsWith(compilerNodeSystemSuffix)) {
                    const sourceFile = ts.createSourceFile(entry,
                        "export function getNodeSystem() { throw new Error('Not supported;'); }",
                        ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);

                    const mod: JSModule = {
                        type: "esm",
                        path: entry,
                        file: sourceFile
                    };
                    modules.set(entry, mod);

                    continue;
                }

                let modPath: string;
                let needsAlias = false;
                if (fsPath.isAbsolute(entry)) {
                    modPath = entry;
                } else {
                    const tokens = entry.split("/");

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
                        if (requesterPath.startsWith(compilerRoot) || requesterPath.startsWith(linkedCompilerRoot)) {
                            modPath = fsPath.join(assets.compilerNodeModulesDir, ...tokens);
                        } else {
                            modPath = fsPath.join(assets.projectNodeModulesDir, ...tokens);
                        }
                        needsAlias = subPath.length > 0;
                    }
                }

                if (sys.directoryExists(modPath)) {
                    const rawPkgMeta = sys.readFile(fsPath.join(modPath, "package.json"));
                    if (rawPkgMeta !== undefined) {
                        const pkgMeta = JSON.parse(rawPkgMeta);
                        const pkgMain = pkgMeta.module ?? pkgMeta.main ?? "index.js";
                        let pkgEntrypoint = fsPath.join(modPath, pkgMain);
                        if (sys.directoryExists(pkgEntrypoint)) {
                            pkgEntrypoint = fsPath.join(pkgEntrypoint, "index.js");
                        }

                        modPath = pkgEntrypoint;
                        needsAlias = true;
                    } else {
                        modPath = fsPath.join(modPath, "index.js");
                    }
                }

                if (!sys.fileExists(modPath)) {
                    modPath += ".js";
                    if (!sys.fileExists(modPath)) {
                        continue;
                    }
                }

                if (needsAlias) {
                    let assetSubPath: string;
                    if (modPath.startsWith(assets.projectNodeModulesDir)) {
                        assetSubPath = modPath.substring(projectRoot.length + 1);
                    } else if (modPath.startsWith(assets.compilerNodeModulesDir)) {
                        assetSubPath = modPath.substring(compilerRoot.length + 1);
                    } else {
                        assetSubPath = fsPath.join("shims", modPath.substring(assets.shimDir.length + 1));
                    }
                    aliases.set("/" + portablePathFromFilePath(assetSubPath), entry);
                }

                const sourceFile = getExternalSourceFile(modPath);

                const mod: JSModule = {
                    type: detectModuleType(modPath, sys),
                    path: modPath,
                    file: sourceFile
                };
                modules.set(modPath, mod);

                processJSModule(mod, processedModules, pendingModules, jsonFilePaths);
            }

            const legacyModules = Array.from(modules.values()).filter(m => m.type === "cjs");
            if (legacyModules.length > 0) {
                const opts = makeCompilerOptions(sys, options);
                const host = ts.createIncrementalCompilerHost(opts, sys);
                const p = ts.createProgram({
                    rootNames: legacyModules.map(m => m.path),
                    options: { ...options, allowJs: true },
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

            for (const [path, mod] of modules) {
                const assetName = assetNameFromFilePath(path);
                if (!output.has(assetName)) {
                    output.set(assetName, mod.file.text);
                    origins.set(assetName, path);
                }
            }

            for (const path of jsonFilePaths) {
                const assetName = assetNameFromFilePath(path);
                if (!output.has(assetName)) {
                    output.set(assetName, sys.readFile(path)!);
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
                        const originPath = origins.get(name)!;
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
            for (const name of orderedNames.filter(name => !name.endsWith(".map"))) {
                let index = (name === entrypoint.output) ? 0 : names.length;

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
                const alias = aliases.get(name);
                if (alias !== undefined) {
                    chunks.push(`↻ ${alias}\n`)
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

            const fullOutputPath = fsPath.isAbsolute(outputPath) ? outputPath : fsPath.join(projectRoot, outputPath);
            origWriteFile(fullOutputPath, chunks.join(""), false);
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

    bundle(program: ts.Program): Promise<void>;
    invalidate(path: string): void;
}

type BundlerEvents = {
    externalSourceFileAdded: (file: ts.SourceFile) => void,
};

function deriveEntrypoint(options: Options): EntrypointName {
    const { projectRoot, inputPath } = options;

    const input = fsPath.isAbsolute(inputPath) ? inputPath : fsPath.join(projectRoot, inputPath);
    if (!input.startsWith(projectRoot)) {
        throw new Error("Entrypoint must be inside the project root");
    }

    let output = input.substring(projectRoot.length);
    if (output.endsWith(".ts")) {
        output = output.substring(0, output.length - 2) + "js";
    }

    return { input, output };
}

function getAssets(sys: ts.System, options: Options): Assets {
    const projectNodeModulesDir = fsPath.join(options.projectRoot, "node_modules");
    const compilerNodeModulesDir = fsPath.join(compilerRoot, "node_modules");
    const shimDir = fsPath.join(compilerRoot, "shims");
    const extShimDir = sys.directoryExists(compilerNodeModulesDir) ? compilerNodeModulesDir : projectNodeModulesDir;

    const shims = new Map([
        ["assert", fsPath.join(extShimDir, "@frida", "assert")],
        ["base64-js", fsPath.join(extShimDir, "@frida", "base64-js")],
        ["buffer", fsPath.join(extShimDir, "@frida", "buffer")],
        ["diagnostics_channel", fsPath.join(extShimDir, "@frida", "diagnostics_channel")],
        ["events", fsPath.join(extShimDir, "@frida", "events")],
        ["fs", fsPath.join(extShimDir, "frida-fs")],
        ["http", fsPath.join(extShimDir, "@frida", "http")],
        ["https", fsPath.join(extShimDir, "@frida", "https")],
        ["http-parser-js", fsPath.join(extShimDir, "@frida", "http-parser-js")],
        ["ieee754", fsPath.join(extShimDir, "@frida", "ieee754")],
        ["net", fsPath.join(extShimDir, "@frida", "net")],
        ["os", fsPath.join(extShimDir, "@frida", "os")],
        ["path", fsPath.join(extShimDir, "@frida", "path")],
        ["process", fsPath.join(extShimDir, "@frida", "process")],
        ["punycode", fsPath.join(extShimDir, "@frida", "punycode")],
        ["querystring", fsPath.join(extShimDir, "@frida", "querystring")],
        ["readable-stream", fsPath.join(extShimDir, "@frida", "readable-stream")],
        ["stream", fsPath.join(extShimDir, "@frida", "stream")],
        ["string_decoder", fsPath.join(extShimDir, "@frida", "string_decoder")],
        ["supports-color", fsPath.join(shimDir, "supports-color.js")],
        ["timers", fsPath.join(extShimDir, "@frida", "timers")],
        ["tty", fsPath.join(extShimDir, "@frida", "tty")],
        ["url", fsPath.join(extShimDir, "@frida", "url")],
        ["util", fsPath.join(extShimDir, "@frida", "util")],
        ["vm", fsPath.join(extShimDir, "@frida", "vm")],
    ]);

    return {
        projectNodeModulesDir,
        compilerNodeModulesDir,
        shimDir,
        shims,
    };
}

interface EntrypointName {
    input: string;
    output: string;
}

interface Assets {
    projectNodeModulesDir: string;
    compilerNodeModulesDir: string;
    shimDir: string;
    shims: Map<string, string>;
}

function makeSystem(options: Options): ts.System {
    let sys: ts.System;
    if (process.env.FRIDA_COMPILE !== undefined) {
        const libDir = fsPath.join(compilerRoot, "ext");
        sys = new FridaSystem(options.projectRoot, libDir);
    } else {
        sys = getNodeSystem();
    }
    return sys;
}

function detectModuleType(modPath: string, sys: ts.System): ModuleType {
    let curDir = fsPath.dirname(modPath);
    while (true) {
        const rawPkgMeta = sys.readFile(fsPath.join(curDir, "package.json"));
        if (rawPkgMeta !== undefined) {
            const pkgMeta = JSON.parse(rawPkgMeta);
            if (pkgMeta.type === "module") {
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

function processJSModule(mod: JSModule, processedModules: Set<string>, pendingModules: Map<string, JSModule>, jsonFilePaths: Set<string>): void {
    const moduleDir = fsPath.dirname(mod.path);
    ts.forEachChild(mod.file, visit);

    function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) {
            visitImportDeclaration(node);
        } else if (ts.isExportDeclaration(node)) {
            visitExportDeclaration(node);
        } else if (ts.isCallExpression(node)) {
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
        const path = resolveAssetReference(name);

        if (name.endsWith(".json")) {
            jsonFilePaths.add(path)
        } else {
            if (!processedModules.has(path)) {
                pendingModules.set(path, mod);
            }
        }
    }

    function resolveAssetReference(name: string): string {
        if (name.startsWith(".")) {
            return fsPath.join(moduleDir, name);
        } else {
            return name;
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
    const jsPath = import.meta.url.substring(isWindows ? 8 : 7);
    const rootPath = fsPath.dirname(fsPath.dirname(jsPath));
    return portablePathToFilePath(rootPath);
}

function portablePathFromFilePath(path: string): string {
    return isWindows ? path.replace(/\\/g, "/") : path;
}

function portablePathToFilePath(path: string): string {
    return isWindows ? path.replace(/\//g, "\\") : path;
}
