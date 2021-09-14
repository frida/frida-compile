import { cjsToEsmTransformer } from "../ext/cjstoesm/dist/index.js";
import fsPath from "path";
import { FridaSystem } from "./system.js";
import ts from "../ext/TypeScript/built/local/typescript.js";

export async function build(projectRoot: string, inputPath: string, outputPath: string): Promise<void> {
    const t1 = Date.now();

    const nodeModulesDir = fsPath.join(projectRoot, "node_modules");
    const libDir = "/Users/oleavr/src/frida-compile/node_modules/typescript/lib";

    const output = new Map<string, string>();
    const pendingModules = new Set<string>();
    const processedModules = new Set<string>();
    const modules = new Map<string, JSModule>();

    let sys: ts.System;
    if (typeof Frida !== "undefined") {
        sys = new FridaSystem(projectRoot, libDir);
    } else {
        sys = ts.sys;
    }

    const configFileHost = new FridaConfigFileHost(projectRoot, sys);

    const defaultOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        allowJs: true,
        strict: true
    };

    const options = ts.getParsedCommandLineOfConfigFile(fsPath.join(projectRoot, "tsconfig.json"), defaultOptions, configFileHost)!.options;
    delete options.noEmit;
    options.rootDir = projectRoot;
    options.outDir = "/";
    options.sourceMap = true;
    options.inlineSourceMap = false;

    const compilerHost = ts.createIncrementalCompilerHost(options, sys);
    compilerHost.writeFile = (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
        output.set(fileName, data);
    };

    const entrypoint = fsPath.isAbsolute(inputPath) ? inputPath : fsPath.join(projectRoot, inputPath);
    if (!entrypoint.startsWith(projectRoot)) {
        throw new Error("Entrypoint must be inside the project root");
    }

    const program = ts.createProgram({
        rootNames: [entrypoint],
        options,
        host: compilerHost
    });

    for (const sf of program.getSourceFiles()) {
        if (!sf.isDeclarationFile) {
            const fileName = sf.fileName;
            const bareName = fileName.substr(0, fileName.lastIndexOf("."));
            processedModules.add(bareName);
        }
    }

    for (const sf of program.getSourceFiles()) {
        if (!sf.isDeclarationFile) {
            const { fileName } = sf;
            const mod: JSModule = {
                type: "esm",
                path: fileName,
                file: sf
            };
            modules.set(fileName, mod);
            processJSModule(mod, processedModules, pendingModules);
        }
    }

    while (pendingModules.size > 0) {
        const entry = pendingModules.values().next().value;
        pendingModules.delete(entry);
        processedModules.add(entry);

        let modPath: string;
        if (fsPath.isAbsolute(entry)) {
            modPath = entry;
        } else {
            const pkgPath = fsPath.join(nodeModulesDir, entry);

            const rawPkgMeta = sys.readFile(fsPath.join(pkgPath, "package.json"));
            if (rawPkgMeta !== undefined) {
                const pkgMeta = JSON.parse(rawPkgMeta);
                const pkgMain = pkgMeta.main ?? "index.js";
                const pkgEntrypoint = fsPath.join(pkgPath, pkgMain);

                modPath = pkgEntrypoint;
            } else if (entry.indexOf("/") !== -1) {
                modPath = pkgPath;
            } else {
                console.log("Assuming built-in:", entry)
                continue;
            }
        }

        if (modPath.endsWith(".json")) {
            console.log("Ignoring JSON:", entry);
            continue;
        }

        if (sys.directoryExists(modPath)) {
            modPath = fsPath.join(modPath, "index.js");
        }

        if (!sys.fileExists(modPath)) {
            modPath += ".js";
            if (!sys.fileExists(modPath)) {
                throw new Error(`Unable to resolve: ${entry}`);
            }
        }

        const sourceFile = compilerHost.getSourceFile(modPath, ts.ScriptTarget.ES2020)!;

        const mod: JSModule = {
            type: "cjs", // TODO: detect
            path: modPath,
            file: sourceFile
        };
        modules.set(modPath, mod);

        processJSModule(mod, processedModules, pendingModules);
    }

    program.emit(undefined, undefined, undefined, undefined, {
        after: [
            useStrictRemovalTransformer(),
        ]
    });

    let legacyModules = Array.from(modules.values()).filter(m => m.type === "cjs");
    legacyModules = legacyModules.slice(0, 1).concat(legacyModules.slice(2, 19));
    if (legacyModules.length > 0) {
        const p = ts.createProgram({
            rootNames: legacyModules.map(m => m.path),
            options,
            host: compilerHost
        });
        console.log("Performing conversion:", legacyModules.map(m => m.path));
        p.emit(undefined, undefined, undefined, undefined, {
            before: [
                cjsToEsmTransformer()
            ],
            after: [
                useStrictRemovalTransformer()
            ]
        });
        console.log("Performed conversion");
    }

    console.log("Output:", Object.fromEntries(output));
}

interface JSModule {
    type: "cjs" | "esm";
    path: string;
    file: ts.SourceFile;
}

function processJSModule(mod: JSModule, processedModules: Set<string>, pendingModules: Set<string>): void {
    const moduleDir = fsPath.dirname(mod.path);
    ts.forEachChild(mod.file, visit);

    function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) {
            visitImportDeclaration(node);
        } else if (ts.isCallExpression(node)) {
            visitCallExpression(node);
        } else {
            ts.forEachChild(node, visit);
        }
    }

    function visitImportDeclaration(imp: ts.ImportDeclaration) {
        const depName = (imp.moduleSpecifier as ts.StringLiteral).text;
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
        const path = resolveModule(name);
        if (!processedModules.has(path)) {
            pendingModules.add(path);
        }
    }

    function resolveModule(name: string): string {
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

build("/Users/oleavr/src/hello-frida", "agent/index.ts", "_agent.js")
    .catch(e => {
        console.error(e.stack);
    });
