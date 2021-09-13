import { cjsToEsmTransformer } from "../ext/cjstoesm/dist/index.js";
import fs from "fs";
import fsPath from "path";
import sjcl from "sjcl";
import ts from "../ext/TypeScript/built/local/typescript.js";

const t1 = Date.now();

const projectRoot = "/Users/oleavr/src/hello-frida";
const nodeModulesDir = fsPath.join(projectRoot, "node_modules");
const libDir = "/Users/oleavr/src/frida-compile/node_modules/typescript/lib";

const output = new Map<string, string>();
const fileCache = new Map<string, string>();
const pendingModules = new Set<string>();
const processedModules = new Set<string>();
const modules = new Map<string, JSModule>();

class FridaSystem implements ts.System {
    args = [];
    newLine = "\n";
    useCaseSensitiveFileNames = true;

    write(s: string): void {
        console.log("TODO: write()");
    }

    writeOutputIsTTY(): boolean {
        console.log("TODO: writeOutputIsTTY()");
        return true;
    }

    readFile(path: string, encoding?: string): string | undefined {
        if (fileCache.has(path)) {
            return fileCache.get(path);
        }

        let result: string | undefined;
        try {
            result = fs.readFileSync(path, { encoding: "utf-8" });
        } catch (e) {
            result = undefined;
        }

        if (result !== undefined) {
            fileCache.set(path, result);
        }

        //console.log(`readFile("${path}") => ${(result !== undefined) ? "success" : "failure"}`);

        return result;
    }

    getFileSize(path: string): number {
        console.log("TODO: getFileSize()");
        return 0;
    }

    writeFile(path: string, data: string, writeByteOrderMark?: boolean): void {
        console.log("writeFile() ignoring:", path);
    }

    watchFile(path: string, callback: ts.FileWatcherCallback, pollingInterval?: number, options?: ts.WatchOptions): ts.FileWatcher {
        console.log("TODO: watchFile()");
        throw new Error("Not implemented");
    }

    watchDirectory(path: string, callback: ts.DirectoryWatcherCallback, recursive?: boolean, options?: ts.WatchOptions): ts.FileWatcher {
        console.log("TODO: watchDirectory()");
        throw new Error("Not implemented");
    }

    resolvePath(path: string): string {
        console.log("TODO: resolvePath()");
        return path;
    }

    fileExists(path: string): boolean {
        try {
            const st = fs.statSync(path);
            return !st.isDirectory();
        } catch (e) {
            return false;
        }
    }

    directoryExists(path: string): boolean {
        try {
            const st = fs.statSync(path);
            return st.isDirectory();
        } catch (e) {
            return false;
        }
    }

    createDirectory(path: string): void {
        console.log("TODO: createDirectory()");
    }

    getExecutingFilePath(): string {
        return fsPath.join(libDir, "typescript.js");
    }

    getCurrentDirectory(): string {
        return projectRoot;
    }

    getDirectories(path: string): string[] {
        console.log("TODO: getDirectories()");
        return [];
    }

    readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[] {
        console.log(`TODO: readDirectory("${path}")`);
        if (extensions !== undefined) {
            console.log(`\textensions: [ ${extensions.join(", ")} ]`);
        }
        if (exclude !== undefined) {
            console.log(`\texclude: [ ${exclude.join(", ")} ]`);
        }
        if (include !== undefined) {
            console.log(`\tinclude: [ ${include.join(", ")} ]`);
        }
        if (depth !== undefined) {
            console.log(`\tdepth: ${depth}`);
        }
        return [];
    }

    getModifiedTime(path: string): Date | undefined {
        console.log("TODO: getModifiedTime()");
        return undefined;
    }

    setModifiedTime(path: string, time: Date): void {
        console.log("TODO: setModifiedTime()");
    }

    deleteFile(path: string): void {
        console.log("TODO: deleteFile()");
    }

    createHash(data: string): string {
        return this.createSHA256Hash(data);
    }

    createSHA256Hash(data: string): string {
        const bits = sjcl.hash.sha256.hash(data);
        return sjcl.codec.hex.fromBits(bits);
    }

    getMemoryUsage(): number {
        return Frida.heapSize;
    }

    exit(exitCode?: number): void {
        console.log("TODO: exit");
    }

    realpath(path: string): string {
        return path;
    }

    getEnvironmentVariable(name: string): string {
        return "";
    }

    setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): any {
        return setTimeout(callback);
    }

    clearTimeout(timeoutId: any): void {
        return clearTimeout(timeoutId);
    }

    clearScreen(): void {
        console.log("TODO: clearScreen");
    }

    base64decode(input: string): string {
        console.log("TODO: base64decode");
        return "yyy";
    }

    base64encode(input: string): string {
        console.log("TODO: base64encode");
        return "zzz";
    }
}

let sys: ts.System;
if (typeof Frida !== "undefined") {
    sys = new FridaSystem();
    //ts.sys = sys;
} else {
    sys = ts.sys;
}

class FridaConfigFileHost implements ts.ParseConfigFileHost {
    useCaseSensitiveFileNames = true;

    readDirectory(rootDir: string, extensions: readonly string[], excludes: readonly string[] | undefined, includes: readonly string[], depth?: number): readonly string[] {
        return sys.readDirectory(rootDir, extensions, excludes, includes, depth);
    }

    fileExists(path: string): boolean {
        return sys.fileExists(path);
    }

    readFile(path: string): string | undefined {
        return sys.readFile(path);
    }

    trace?(s: string): void {
        console.log(s);
    }

    getCurrentDirectory(): string {
        return projectRoot;
    }

    onUnRecoverableConfigFileDiagnostic(diagnostic: ts.Diagnostic) {
    }
}

const configFileHost = new FridaConfigFileHost();

const defaultOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    allowJs: true,
    strict: true
};

const options = ts.getParsedCommandLineOfConfigFile(fsPath.join(projectRoot, "tsconfig.json"), defaultOptions, configFileHost)!.options;
delete options.noEmit;
options.rootDir = projectRoot;
options.outDir = "/";
options.inlineSourceMap = true;

const compilerHost = ts.createIncrementalCompilerHost(options, sys);
compilerHost.writeFile = (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
    output.set(fileName, data);
};

const entrypointPath = fsPath.join(projectRoot, "agent", "index.ts");

const program = ts.createProgram({
    rootNames: [entrypointPath],
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

const removeUseStrict: ts.TransformerFactory<ts.SourceFile> = context => {
    return sourceFile => {
        console.log(`Visiting ${sourceFile.fileName}`);

        let done = false;
        const { factory } = context;
        const visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
            if (ts.isExpressionStatement(node)) {
                const expression = node.expression;
                if (ts.isStringLiteral(expression) && expression.text === "use strict") {
                    return [];
                }
            }

            return ts.visitEachChild(node, visitor, context);
        };

        return ts.visitNode(sourceFile, visitor);
    };
};

program.emit(undefined, undefined, undefined, undefined, {
    after: [
        removeUseStrict,
    ]
]});

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
            removeUseStrict,
        ]
    });
    console.log("Performed conversion");
    console.log("output:", Object.fromEntries(output));
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
